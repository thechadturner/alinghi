import { createEffect, createSignal, onMount, onCleanup, Show, untrack } from "solid-js";
import * as d3 from "d3";
import { regressionLog, regressionLoess } from "d3-regression";

import { lasso } from "../../utils/d3-lasso";
import { formatDateTime, putData } from "../../utils/global";
import { resolveDataField } from "../../utils/colorScale";
import { error as logError, debug as logDebug } from "../../utils/console";
import { apiEndpoints } from "../../config/env";

// Static import for worker - Vite will bundle this correctly in production
import LassoSelectionWorker from "../../workers/lasso-selection-processor.ts?worker";

import { setTooltip } from "../../store/globalStore";
import { selectedEvents, setSelectedEvents, triggerSelection, setTriggerSelection, setHasSelection, clearSelection, isEventHidden } from "../../store/selectionStore";
import { selectedStatesTimeseries, selectedRacesTimeseries, selectedLegsTimeseries, selectedGradesTimeseries } from "../../store/filterStore";
import { isDark, theme, getStrokeColor as getThemeStrokeColor } from "../../store/themeStore";
import { user } from "../../store/userStore";
import { persistantStore } from "../../store/persistantStore";
import {
  axisBracketSuffixForSpeedChannel,
  fieldBaseKeyForMatching,
  stripSpeedUnderscoreSuffixFromChannel,
} from "../../utils/speedUnits";
import { defaultChannelsStore } from "../../store/defaultChannelsStore";
import { unifiedDataStore } from "../../store/unifiedDataStore";
import { huniDBStore } from "../../store/huniDBStore";

import Table from "./FitTable";
import infoIconUrl from "../../assets/info.svg";
import warningIconUrl from "../../assets/warning.svg";

interface AdvancedScatterProps {
    // Data props (cloud optional for backward compatibility)
    aggregates: any;
    aggregatesAVG?: any;  // NEW - separate aggregate data by type
    aggregatesSTD?: any;  // NEW
    aggregatesAAV?: any;  // NEW
    cloud?: any;  // Optional - only PerfScatter uses this
    targets?: any;
    
    // Axis props
    xaxis: string;
    yaxis: string;
    taxis: string;
    
    // Filter props
    filters: string[];
    uwDw?: string;
    updateCharts?: boolean;
    
    // Color props (support both modes)
    color?: string;
    groups?: Array<{ name: string; color: string }>;
    colorScale?: (source: string) => string;  // FleetScatter feature
    selectedSource?: string;  // FleetScatter feature
    
    // Aggregate type (backward compatibility - use yType for y-axis)
    aggregate?: string;
    xType?: string;  // NEW - aggregate type for x-axis
    yType?: string;  // NEW - aggregate type for y-axis
    
    // Interaction props
    zoom?: boolean;
    handleZoom?: (info: any[]) => void;
    mouseID?: any;
    setMouseID?: (id: number | null) => void;
    highlights?: any[];
    onDataUpdate?: () => void;
    /** Called when the chart has finished drawing (e.g. after upwind/downwind switch). Used to hide mode-switching overlay. */
    onChartRendered?: () => void;
    /** Info/warning message for bottom-right icon and tooltip */
    infoType?: string;
    infoMessage?: string;
    [key: string]: any;
}

export default function AdvancedScatter(props: AdvancedScatterProps) {
    // Signals
    const [filtered, setFiltered] = createSignal<any[]>([]);
    const [isUpdatingGrade, setIsUpdatingGrade] = createSignal(false);
    const [fitData, setFitData] = createSignal<any[]>([]);
    const [fitDataVersion, setFitDataVersion] = createSignal(0);
    const [loessBandwidth, setLoessBandwidth] = createSignal(0.5);
    const [isComputingLassoSelection, setIsComputingLassoSelection] = createSignal(false);
    const [isVisible, setIsVisible] = createSignal(false);

    // Refs and observers
    let containerRef: HTMLElement | null = document.getElementById('main-content');
    let chartRef: HTMLDivElement | null = null;
    let intersectionObserver: IntersectionObserver | null = null;
    let listenersAttached = false;
    let lastCloudCheckTime = 0;
    const CLOUD_CHECK_THROTTLE_MS = 500; // Throttle cloud checks to prevent excessive redraws
    let lastVisibilityEffectTime = 0;
    const VISIBILITY_EFFECT_THROTTLE_MS = 1000; // Throttle visibility effect cloud checks
    let lastVisibilityState = false;
    let isCleaningUp = false; // Flag to track if component is being cleaned up
    
    // Store listener functions so they can be reused for attach/detach
    let storedMouseover: ((event: MouseEvent, d: any) => void) | null = null;
    let storedMouseout: (() => void) | null = null;
    let storedClick: ((event: MouseEvent, d: any) => void) | null = null;

    // Use defaultChannelsStore for channel names
    const { twaName, bspName, twsName } = defaultChannelsStore;

    // Chart dimensions and scales
    let xMin = 9999999;
    let xMax = -9999999;
    let yMin = 9999999;
    let yMax = -9999999;
    let margin = { top: 10, right: 10, bottom: 80, left: 50 };
    let chartWidth = 450 - margin.left - margin.right;
    let chartHeight = 500 - margin.top - margin.bottom;
    let xScale: d3.ScaleLinear<number, number, never> = d3.scaleLinear();
    let yScale: d3.ScaleLinear<number, number, never> = d3.scaleLinear();

    // Flags and workers
    let allowclick = true;
    let isLassoActive = false;
    let isComputingSelection = false;
    let lassoWorker: Worker | null = null;
    let lastGradeUpdateTime = 0;
    let isUpdatingData = false; // Flag to prevent filter effect during data updates

    // Captured prop values for use in non-reactive contexts
    let lastCapturedAggregates: any[] | undefined = undefined;
    let lastCapturedCloud: any[] | undefined = undefined;

    // Color functions (will be redefined in drawScatter)
    let getFillColor: ((d: any) => string) | undefined;
    let getStrokeColor: ((d: any) => string) | undefined;

    // Map of Twa_deg_avg from AVG aggregates for filtering STD/AAV aggregates
    // This is updated in drawChart and used by getTwa
    let avgTwaDegAvgMap = new Map<string | number, number>();

    // Update captured values whenever props change (within reactive context)
    createEffect(() => {
        if (isCleaningUp) return; // Don't run during cleanup
        lastCapturedAggregates = props.aggregates;
        const previousCloud = lastCapturedCloud;
        const currentCloud = props.cloud;
        lastCapturedCloud = currentCloud;
        
        // Remove cloud area if cloud is empty or not provided
        const cloudIsEmpty = !currentCloud || (Array.isArray(currentCloud) && currentCloud.length === 0);
        const cloudWasRemoved = previousCloud && (Array.isArray(previousCloud) && previousCloud.length > 0) && cloudIsEmpty;
        
        if (cloudIsEmpty || cloudWasRemoved) {
            // Immediately remove cloud area synchronously
            if (chartRef) {
                const svg = d3.select(chartRef).select("svg");
                if (svg.node()) {
                    // Remove from all possible locations synchronously
                    svg.selectAll(".cloud-area").remove();
                    svg.selectAll("g.cloud-area").remove();
                    const chartbody = svg.select("g");
                    if (chartbody.node()) {
                        chartbody.selectAll(".cloud-area").remove();
                        chartbody.selectAll("g.cloud-area").remove();
                    }
                    // Also call removeCloudArea for any other locations
                    removeCloudArea();
                    
                    // If chart is visible and has data elements, immediately redraw to ensure cloud is removed
                    const hasScatterPoints = d3.select(chartRef).selectAll(".scatter").size() > 0;
                    if (isVisible() && hasScatterPoints) {
                        // Use current props.cloud (empty array) directly, not lastCapturedCloud
                        logDebug('AdvancedScatter: Triggering immediate redraw to remove cloud');
                        drawDataElementsOnly(lastCapturedAggregates, currentCloud);
                    }
                } else {
                    // Chart not rendered yet, but still remove from any existing elements
                    removeCloudArea();
                }
            } else {
                // No chart ref yet, but still try to remove
                removeCloudArea();
            }
        }
    });

    // Helper function to get TWA value
    // Twa_deg_avg is metadata (always from AVG) - use it for consistent upwind/downwind filtering
    // Twa_deg is the actual data field for the aggregate type being queried
    // After fixes, Twa_deg_avg should be present in all aggregates (AVG, STD, AAV)
    const getTwa = (d: any): number => {
        if (!d) return 0;
        
        // First, check Twa_deg_avg directly in the data point (should be present in all aggregates)
        const twaAvg = d.Twa_deg_avg ?? d.twa_deg_avg;
        if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Number(twaAvg);
        }
        
        // Fallback: If Twa_deg_avg is missing (backward compatibility), try AVG aggregates map
        if (d.event_id !== undefined && avgTwaDegAvgMap.has(d.event_id)) {
            return avgTwaDegAvgMap.get(d.event_id)!;
        }
        
        // Fallback: Try to find in props.aggregatesAVG array
        if (props.aggregatesAVG && Array.isArray(props.aggregatesAVG) && d.event_id !== undefined) {
            const avgPoint = props.aggregatesAVG.find((avg: any) => avg.event_id === d.event_id);
            if (avgPoint) {
                const avgTwaAvg = avgPoint.Twa_deg_avg ?? avgPoint.twa_deg_avg;
                if (avgTwaAvg !== undefined && avgTwaAvg !== null && !isNaN(Number(avgTwaAvg))) {
                    return Number(avgTwaAvg);
                }
            }
        }
        
        // Last resort: fallback to regular Twa_deg field (data field for the aggregate type)
        // This is NOT ideal for filtering but better than returning 0
        const twaField = twaName();
        const val = d[twaField] ?? d.Twa_deg ?? 0;
        return Number(val) || 0;
    };

    // Unified color function supporting both source-based and groups-based coloring
    const getColor = (d: any): string => {
        // If colorScale is provided AND color is SOURCE_NAME, use colorScale
        if (props.color === 'SOURCE_NAME' && props.colorScale && typeof props.colorScale === 'function') {
            const sourceName = d.source_name || d.sourceName || d.source || d.SOURCE || d.SOURCE_NAME;
            if (sourceName) {
                const normalizedSource = String(sourceName).toLowerCase();
                try {
                    const color = props.colorScale(normalizedSource);
                    // Ensure we got a valid color string
                    if (color && typeof color === 'string' && color !== 'undefined' && color !== 'null') {
                        return color;
                    }
                } catch (error) {
                    logDebug('AdvancedScatter: Error calling colorScale', { error, sourceName: normalizedSource });
                }
            }
        }

        // If color prop is provided and groups are available, use them
        if (props.color && props.groups && Array.isArray(props.groups)) {
            // For STATE, data is normalized to lowercase 'state' field
            let value: any;
            if (props.color === 'STATE') {
                // Try multiple field name variations for STATE
                value = d.state || d.State || d.STATE || resolveDataField(d, 'state') || resolveDataField(d, 'STATE');
            } else {
                value = resolveDataField(d, props.color);
            }

            // Special handling for RACE: convert -1 to 'TRAINING'
            if (props.color === 'RACE' && (value === -1 || value === '-1')) {
                value = 'TRAINING';
            }

            // When colored by LEG, training / -1 always use light grey (match legend)
            if (props.color === 'LEG') {
                const note = value !== undefined && value !== null ? String(value) : '';
                if (note === 'TRAINING' || note === 'training' || note === '-1' || value === -1) {
                    return 'lightgrey';
                }
            }

            const valueStr = value !== undefined && value !== null ? String(value) : null;
            let group = null;
            if (valueStr !== null) {
                group = props.groups.find(group => {
                    // For STATE, use case-insensitive comparison
                    if (props.color === 'STATE') {
                        return String(group.name).toLowerCase() === valueStr.toLowerCase();
                    }
                    // Exact match
                    if (String(group.name) === valueStr) return true;
                    // Numeric comparison
                    const groupNum = Number(group.name);
                    const valueNum = Number(valueStr);
                    if (!isNaN(groupNum) && !isNaN(valueNum) && groupNum === valueNum) return true;
                    // Case-insensitive match
                    if (String(group.name).toLowerCase() === valueStr.toLowerCase()) return true;
                    return false;
                });
            }

            return group ? group.color : "lightgrey";
        }

        return "lightgrey";
    };

    // Filter data by position and tack
    function filterData(collection: any[], pos: string, tack: string): any[] {
        try {
            if (collection != undefined) {
                collection.forEach(function (d: any) {
                    const twa = getTwa(d);
                    if (twa < 0) {
                        d.tack = 'PORT';
                    } else {
                        d.tack = 'STBD';
                    }
                    d.Datetime = formatDateTime(d.Datetime);
                });

                if (pos === 'UW') {
                    if (tack === 'PORT') {
                        return collection.filter((d: any) => {
                            const twa = getTwa(d);
                            return twa < 0 && Math.abs(twa) < 90;
                        });
                    } else if (tack === 'STBD') {
                        return collection.filter((d: any) => {
                            const twa = getTwa(d);
                            return twa > 0 && Math.abs(twa) < 90;
                        });
                    } else if (tack === 'BOTH') {
                        return collection.filter((d: any) => {
                            const twa = getTwa(d);
                            return Math.abs(twa) < 90;
                        });
                    }
                    return [];
                } else if (pos === 'DW') {
                    if (tack === 'PORT') {
                        return collection.filter((d: any) => {
                            const twa = getTwa(d);
                            return twa < 0 && Math.abs(twa) > 90;
                        });
                    } else if (tack === 'STBD') {
                        return collection.filter((d: any) => {
                            const twa = getTwa(d);
                            return twa > 0 && Math.abs(twa) > 90;
                        });
                    } else if (tack === 'BOTH') {
                        return collection.filter((d: any) => {
                            const twa = getTwa(d);
                            return Math.abs(twa) > 90;
                        });
                    }
                    return [];
                } else {
                    return collection;
                }
            } else {
                return [];
            }
        } catch {
            return [];
        }
    }

    // Reduce data to X/Y coordinates with metadata
    // Now supports separate xType and yType for x-axis and y-axis aggregate types
    function reduceData(collection: any[], x: string, y: string, xDataCollection?: any[], yDataCollection?: any[]): any[] {
        // If separate x and y data collections are provided, use them; otherwise use the main collection
        // The passed collections are already filtered and contain the correct aggregate type data
        let xCollectionToUse = xDataCollection || collection;
        let yCollectionToUse = yDataCollection || collection;
        
        // If collections weren't provided but we have separate aggregate data, use the appropriate type
        if (!xDataCollection && !yDataCollection && (props.aggregatesAVG || props.aggregatesSTD || props.aggregatesAAV)) {
            const xType = (props.xType || props.aggregate || 'AVG').toUpperCase();
            const yType = (props.yType || props.aggregate || 'AVG').toUpperCase();
            const aggregatesByType: { [key: string]: any[] } = {
                AVG: props.aggregatesAVG || [],
                STD: props.aggregatesSTD || [],
                AAV: props.aggregatesAAV || []
            };
            xCollectionToUse = aggregatesByType[xType] || collection;
            yCollectionToUse = aggregatesByType[yType] || collection;
        }
        // Filter out hidden events so they are not rendered
        xCollectionToUse = (xCollectionToUse || []).filter((d: any) => d.event_id == null || d.event_id === undefined || !isEventHidden(Number(d.event_id)));
        yCollectionToUse = (yCollectionToUse || []).filter((d: any) => d.event_id == null || d.event_id === undefined || !isEventHidden(Number(d.event_id)));
        
        // Create a map of AVG data by event_id for TACK lookup (TACK from API should be correct for all aggregate types)
        // But prefer TACK from AVG data point when combining x/y from different aggregate types
        // Also create a map for Twa_deg_avg lookup for filtering STD/AAV aggregates
        const avgDataMap = new Map<string | number, any>();
        const avgTwaDegAvgMap = new Map<string | number, number>();
        if (props.aggregatesAVG && Array.isArray(props.aggregatesAVG)) {
            props.aggregatesAVG.forEach((d: any) => {
                const eventId = d.event_id;
                if (eventId !== undefined && eventId !== null) {
                    avgDataMap.set(eventId, d);
                    // Store Twa_deg_avg for quick lookup during filtering
                    const twaDegAvg = d.Twa_deg_avg ?? d.twa_deg_avg;
                    if (twaDegAvg !== undefined && twaDegAvg !== null && !isNaN(Number(twaDegAvg))) {
                        avgTwaDegAvgMap.set(eventId, Number(twaDegAvg));
                    }
                }
            });
        }
        
        if ((xCollectionToUse != undefined && xCollectionToUse.length > 0) || (yCollectionToUse != undefined && yCollectionToUse.length > 0)) {
            
            // Detect if this is cloud data (1Hz) vs aggregate data
            // Cloud data has many points per event_id, aggregate data has one point per event_id
            // Check if we have multiple points with the same event_id
            const eventIdCounts = new Map<string | number, number>();
            const collectionToCheck = xCollectionToUse.length > 0 ? xCollectionToUse : yCollectionToUse;
            collectionToCheck.forEach((d: any) => {
                const eventId = d.event_id;
                if (eventId !== undefined && eventId !== null) {
                    eventIdCounts.set(eventId, (eventIdCounts.get(eventId) || 0) + 1);
                }
            });
            const maxPointsPerEvent = Math.max(...Array.from(eventIdCounts.values()), 0);
            const isCloudData = maxPointsPerEvent > 1; // Cloud data has multiple points per event_id
            
            if (isCloudData) {
                // For cloud data (1Hz), process each point individually - don't group by event_id
                // Both x and y values should be in the same point (same collection)
                const combinedData = collectionToCheck.map((point: any) => {
                    // Extract x and y values from the same point
                    const xFieldValue = resolveDataField(point, x);
                    const yFieldValue = resolveDataField(point, y);
                    
                    const xFieldExists = xFieldValue !== undefined && xFieldValue !== null;
                    const yFieldExists = yFieldValue !== undefined && yFieldValue !== null;
                    
                    if (xFieldExists && yFieldExists) {
                        const datetime = new Date(point.Datetime || point.datetime);
                        const sourceNameOriginal = point.source_name || point.sourceName || point.source || point.SOURCE || point.SOURCE_NAME || 'Unknown';
                        const sourceKeyLower = String(sourceNameOriginal).toLowerCase();
                        const year = datetime ? datetime.getFullYear() : null;
                        let eventIdNum: number | undefined = undefined;
                        const eventId = point.event_id;
                        if (eventId !== undefined && eventId !== null) {
                            const parsed = typeof eventId === 'string' ? parseInt(eventId, 10) : Number(eventId);
                            eventIdNum = isNaN(parsed) ? undefined : parsed;
                        }
                        
                        const xNum = (xFieldValue !== undefined && xFieldValue !== null && !isNaN(Number(xFieldValue))) ? Number(xFieldValue) : 0;
                        const yNum = (yFieldValue !== undefined && yFieldValue !== null && !isNaN(Number(yFieldValue))) ? Number(yFieldValue) : 0;

                        // Single nomenclature: read via resolveDataField; combined point uses lowercase keys only
                        const tack = resolveDataField(point, 'TACK') ?? point.tack ?? 'STBD';
                        const twaDegAvg = point.Twa_deg_avg ?? point.twa_deg_avg ?? undefined;
                        let raceVal = resolveDataField(point, 'RACE');
                        if (raceVal === -1 || raceVal === '-1') raceVal = 'TRAINING';

                        return {
                            ID: eventIdNum,
                            event_id: eventIdNum,
                            Datetime: datetime,
                            datetime,
                            dateStringLocal: point.dateStringLocal,
                            timeStringLocal: point.timeStringLocal,
                            Twa_deg_avg: twaDegAvg,
                            twa_deg_avg: twaDegAvg,
                            tack,
                            race_number: raceVal,
                            leg_number: resolveDataField(point, 'LEG') ?? point.leg_number,
                            grade: resolveDataField(point, 'GRADE') ?? point.grade,
                            state: resolveDataField(point, 'STATE') ?? point.state,
                            config: resolveDataField(point, 'CONFIG') ?? point.config,
                            event: resolveDataField(point, 'EVENT') ?? point.event,
                            year: year ?? resolveDataField(point, 'YEAR') ?? point.year,
                            source_name: sourceKeyLower,
                            X: xNum,
                            Y: yNum
                        };
                    }
                    return null;
                }).filter((item: any) => item !== null);
                
                return combinedData;
            } else {
                // For aggregate data, group by event_id (one point per event_id)
                // Create maps of x and y data by event_id for efficient lookup
                const xDataMap = new Map<string | number, any>();
                xCollectionToUse.forEach((d: any) => {
                    const eventId = d.event_id;
                    if (eventId !== undefined && eventId !== null) {
                        // Check if x value exists for this point
                        const xVal = resolveDataField(d, x);
                        if (xVal !== null && xVal !== undefined) {
                            xDataMap.set(eventId, d);
                        }
                    }
                });
                
                const yDataMap = new Map<string | number, any>();
                yCollectionToUse.forEach((d: any) => {
                    const eventId = d.event_id;
                    if (eventId !== undefined && eventId !== null) {
                        // Check if y value exists for this point
                        const yVal = resolveDataField(d, y);
                        if (yVal !== null && yVal !== undefined) {
                            yDataMap.set(eventId, d);
                        }
                    }
                });
                
                // Get all unique event_ids that have both x and y values
                const validEventIds = new Set<string | number>();
                xDataMap.forEach((_, eventId) => {
                    if (yDataMap.has(eventId)) {
                        validEventIds.add(eventId);
                    }
                });
                
                // Create combined data points for each event_id that has both x and y values
                const combinedData = Array.from(validEventIds).map((eventId) => {
                    const xPoint = xDataMap.get(eventId)!;
                    const yPoint = yDataMap.get(eventId)!;
                    const avgPoint = avgDataMap.get(eventId);
                    
                    // Extract x value from x-point using x channel name
                    const xFieldValue = resolveDataField(xPoint, x);
                    // Extract y value from y-point using y channel name
                    const yFieldValue = resolveDataField(yPoint, y);
                    
                    const xFieldExists = xFieldValue !== undefined && xFieldValue !== null;
                    const yFieldExists = yFieldValue !== undefined && yFieldValue !== null;
                    
                    if (xFieldExists && yFieldExists) {
                        const datetime = new Date(xPoint.Datetime || yPoint.Datetime);
                        const sourceNameOriginal = xPoint.source_name || xPoint.sourceName || xPoint.source || xPoint.SOURCE || xPoint.SOURCE_NAME || yPoint.source_name || yPoint.sourceName || 'Unknown';
                        const sourceKeyLower = String(sourceNameOriginal).toLowerCase();
                        const year = datetime ? datetime.getFullYear() : null;
                        let eventIdNum: number | undefined = undefined;
                        if (eventId !== undefined && eventId !== null) {
                            const parsed = typeof eventId === 'string' ? parseInt(eventId, 10) : Number(eventId);
                            eventIdNum = isNaN(parsed) ? undefined : parsed;
                        }
                        
                        const xNum = (xFieldValue !== undefined && xFieldValue !== null && !isNaN(Number(xFieldValue))) ? Number(xFieldValue) : 0;
                        const yNum = (yFieldValue !== undefined && yFieldValue !== null && !isNaN(Number(yFieldValue))) ? Number(yFieldValue) : 0;

                        // Single nomenclature: read via resolveDataField; combined point uses lowercase keys only
                        const tack = resolveDataField(avgPoint ?? yPoint, 'TACK') ?? resolveDataField(yPoint, 'TACK') ?? resolveDataField(xPoint, 'TACK') ?? yPoint.tack ?? xPoint.tack ?? 'STBD';
                        const twaDegAvg = avgPoint?.Twa_deg_avg ?? avgPoint?.twa_deg_avg ?? yPoint?.Twa_deg_avg ?? yPoint?.twa_deg_avg ?? xPoint?.Twa_deg_avg ?? xPoint?.twa_deg_avg ?? undefined;
                        let raceVal = resolveDataField(xPoint, 'RACE') ?? resolveDataField(yPoint, 'RACE');
                        if (raceVal === -1 || raceVal === '-1') raceVal = 'TRAINING';

                        return {
                            ID: eventIdNum,
                            Datetime: datetime,
                            datetime,
                            dateStringLocal: xPoint.dateStringLocal ?? yPoint.dateStringLocal,
                            timeStringLocal: xPoint.timeStringLocal ?? yPoint.timeStringLocal,
                            Twa_deg_avg: twaDegAvg,
                            twa_deg_avg: twaDegAvg,
                            tack,
                            race_number: raceVal,
                            leg_number: resolveDataField(xPoint, 'LEG') ?? resolveDataField(yPoint, 'LEG') ?? xPoint.leg_number ?? yPoint.leg_number,
                            grade: resolveDataField(xPoint, 'GRADE') ?? resolveDataField(yPoint, 'GRADE') ?? xPoint.grade ?? yPoint.grade,
                            state: resolveDataField(xPoint, 'STATE') ?? resolveDataField(yPoint, 'STATE') ?? xPoint.state ?? yPoint.state,
                            config: resolveDataField(xPoint, 'CONFIG') ?? resolveDataField(yPoint, 'CONFIG') ?? xPoint.config ?? yPoint.config,
                            event: resolveDataField(xPoint, 'EVENT') ?? resolveDataField(yPoint, 'EVENT') ?? xPoint.event ?? yPoint.event,
                            year: year ?? resolveDataField(xPoint, 'YEAR') ?? resolveDataField(yPoint, 'YEAR') ?? xPoint.year ?? yPoint.year,
                            source_name: sourceKeyLower,
                            X: xNum,
                            Y: yNum
                        };
                    }
                    return null;
                }).filter((item: any) => item !== null);
                
                return combinedData;
            }
        } else {
            return [];
        }
    }

    // Reduce targets to X/Y coordinates
    function reduceTargets(collection: any[], x: string, y: string): any[] {
        logDebug('AdvancedScatter reduceTargets: Called', {
            collectionLength: collection?.length || 0,
            x,
            y,
            firstItemKeys: collection?.[0] ? Object.keys(collection[0]) : []
        });
        
        if (collection != undefined && collection.length > 0) {
            // Try both original case and lowercase - data fields may be in either format
            const xFieldLower = x.toLowerCase();
            const yFieldLower = y.toLowerCase();
            
            // Target fields may be bare bases; channel names may include speed/angle suffixes and `_target`.
            const xBaseField = fieldBaseKeyForMatching(x);
            const yBaseField = fieldBaseKeyForMatching(y);
            
            logDebug('AdvancedScatter reduceTargets: Field matching', {
                x,
                xFieldLower,
                xBaseField,
                y,
                yFieldLower,
                yBaseField,
                firstItem: collection[0],
                availableFields: Object.keys(collection[0])
            });
            
            // Filter data where y field is not null (try multiple field name variations)
            let data = collection.filter((d: any) => {
                return (d[y] !== null && d[y] !== undefined) || 
                       (d[yFieldLower] !== null && d[yFieldLower] !== undefined) ||
                       (d[yBaseField] !== null && d[yBaseField] !== undefined);
            });

            logDebug('AdvancedScatter reduceTargets: After filtering', {
                originalLength: collection.length,
                filteredLength: data.length
            });

            if (data.length > 0) {
                const firstItem = data[0];
                const availableFields = Object.keys(firstItem);
                
                // Try to find x field: try exact match, then lowercase, then base field
                let xField = x;
                if (x in firstItem) {
                    xField = x;
                } else if (xFieldLower in firstItem) {
                    xField = xFieldLower;
                } else if (xBaseField in firstItem) {
                    xField = xBaseField;
                } else {
                    const xMatch = availableFields.find(f => {
                        const fLower = f.toLowerCase();
                        const fBase = fieldBaseKeyForMatching(f);
                        return fLower === xBaseField || fBase === xBaseField || fLower === x || fLower === xFieldLower;
                    });
                    if (xMatch) {
                        xField = xMatch;
                        logDebug('AdvancedScatter reduceTargets: Found x field by partial match', { xField, searched: xBaseField });
                    }
                }
                
                // Try to find y field: try exact match, then lowercase, then base field
                let yField = y;
                if (y in firstItem) {
                    yField = y;
                } else if (yFieldLower in firstItem) {
                    yField = yFieldLower;
                } else if (yBaseField in firstItem) {
                    yField = yBaseField;
                } else {
                    // Try to find by partial match
                    // Also handle "_target" suffix in field matching
                    const yMatch = availableFields.find(f => {
                        const fLower = f.toLowerCase();
                        const fBase = fieldBaseKeyForMatching(f);
                        return fLower === yBaseField || fBase === yBaseField || fLower === y || fLower === yFieldLower;
                    });
                    if (yMatch) {
                        yField = yMatch;
                        logDebug('AdvancedScatter reduceTargets: Found y field by partial match', { yField, searched: yBaseField });
                    }
                }
                
                // Check if both x and y fields exist in the data
                logDebug('AdvancedScatter reduceTargets: Field resolution', {
                    xField,
                    yField,
                    xFieldExists: xField in firstItem,
                    yFieldExists: yField in firstItem,
                    availableFields
                });
                
                if (xField in firstItem && yField in firstItem) {
                    data.forEach((d: any) => {
                        if (d[yField] == undefined || d[yField] == null) {
                            d[yField] = 0;
                        }
                        if (d[xField] == undefined || d[xField] == null) {
                            d[xField] = 0;
                        }
                    });

                    const result = data.map((d: any) => ({
                        X: +d[xField] || 0,
                        Y: +d[yField] || 0
                    }));
                    
                    logDebug('AdvancedScatter reduceTargets: Success', {
                        resultLength: result.length,
                        firstFewPoints: result.slice(0, 3)
                    });
                    
                    return result;
                } else {
                    logError(`AdvancedScatter reduceTargets: Fields not found in data. Looking for x: "${x}" (tried: ${x}, ${xFieldLower}, ${xBaseField}), y: "${y}" (tried: ${y}, ${yFieldLower}, ${yBaseField}). Found xField: "${xField}", yField: "${yField}". Available fields:`, availableFields);
                    logError('AdvancedScatter reduceTargets: First item sample', {
                        firstItem,
                        xFieldValue: firstItem[xField],
                        yFieldValue: firstItem[yField]
                    });
                    return [];
                }
            } else {
                return [];
            }
        } else {
            return [];
        }
    }

    // Get X bounds with minimum range enforcement (from PerfScatter)
    function getXBounds(targets: any[][], cloudData?: any[], aggregateData?: any[]): void {
        xMin = 9999999;
        xMax = -9999999;

        // Check if x-axis is the default (TWA)
        const twaChannel = twaName().toLowerCase();
        const xaxisLower = props.xaxis ? props.xaxis.toLowerCase() : '';
        const isDefaultXAxis = xaxisLower === twaChannel || xaxisLower === 'twa';

        // For default x-axis, use cloud and aggregate points combined
        if (isDefaultXAxis && (cloudData || aggregateData)) {
            // Combine cloud and aggregate data for bounds calculation
            const combinedData: any[] = [];
            if (cloudData && cloudData.length > 0) {
                combinedData.push(...cloudData);
            }
            if (aggregateData && aggregateData.length > 0) {
                combinedData.push(...aggregateData);
            }

            // Calculate min/max from combined cloud and aggregate points
            combinedData.forEach((d: any) => {
                if (d && d.X !== undefined && d.X !== null) {
                    if (d.X > xMax) {
                        xMax = d.X;
                    }
                    if (d.X < xMin) {
                        xMin = d.X;
                    }
                }
            });
        } else {
            // For non-default x-axis or when no cloud/aggregate data, use targets
            targets.forEach((targetArray: any[]) => {
                if (targetArray && targetArray.length > 0) {
                    targetArray.forEach((d: any) => {
                        if (d.X > xMax) {
                            xMax = d.X;
                        }
                        if (d.X < xMin) {
                            xMin = d.X;
                        }
                    });
                }
            });
        }

        // If no valid bounds were found, keep sentinel values
        if (xMin === 9999999 || xMax === -9999999) {
            return;
        }

        // Store original minimum to check if data goes below zero
        const originalXMin = xMin;

        // If x-axis is not the default, set xMax to 10% bigger than the maximum value
        if (!isDefaultXAxis) {
            const maxValue = xMax;
            xMax = maxValue * 1.1; // 10% bigger
        } else {
            // Default x-axis: calculate interval from min/max difference, divide by 10
            // Add one interval to max, subtract one interval from min
            const dataRange = Math.abs(xMax - xMin);
            const interval = dataRange / 10;
            xMax += interval;
            xMin -= interval;
        }

        // Enforce minimum 4-knot range for x-axis to ensure target line visibility (from PerfScatter)
        const minRange = 4;
        const currentRange = xMax - xMin;
        if (currentRange < minRange) {
            const center = (xMax + xMin) / 2;
            xMin = center - minRange / 2;
            xMax = center + minRange / 2;
            // Recalculate interval after minRange adjustment for default x-axis
            if (isDefaultXAxis) {
                const adjustedInterval = Math.abs(xMax - xMin) / 10;
                xMax += adjustedInterval;
                xMin -= adjustedInterval;
            }
        }

        // For default x-axis, ensure we have proper padding by rounding down min and rounding up max
        if (isDefaultXAxis) {
            // Round min down (floor) and max up (ceil) to ensure data fits within bounds
            // This ensures the interval padding is preserved
            xMin = Math.floor(xMin);
            xMax = Math.ceil(xMax);
        } else {
            // For non-default, use original rounding
            xMax = Number((xMax + 0.5).toFixed(0));
            xMin = Number((xMin - 0.5).toFixed(0));
        }
        
        // Set minimum to zero if original data values don't go below zero
        if (originalXMin >= 0 && xMin < 0) {
            xMin = 0;
        }
    }

    // Get Y bounds with STD/AAV handling
    function getYBounds(targets: any[][]): void {
        yMin = 9999999;
        yMax = -9999999;

        targets.forEach((targetArray: any[]) => {
            if (targetArray && targetArray.length > 0) {
                targetArray.forEach((d: any) => {
                    if (d.Y > yMax) {
                        yMax = d.Y;
                    }
                    if (d.Y < yMin) {
                        yMin = d.Y;
                    }
                });
            }
        });

        if (yMin === 9999999 || yMax === -9999999) {
            yMin = 0;
            yMax = 10;
            return;
        }

        // Store original minimum to check if data goes below zero
        const originalYMin = yMin;

        const yType = (props.yType || props.aggregate || 'AVG').toUpperCase();
        if (yType === 'STD' || yType === 'AAV') {
            const actualMax = yMax;
            yMin = 0;
            yMax = Number((actualMax * 1.5).toFixed(1));
        } else {
            let range = yMax - yMin;
            if (Math.abs(range) < 1e-9) {
                const center = yMax;
                const pad = Math.max(0.1, Math.abs(center) * 0.1);
                yMax = Number((center + pad).toFixed(2));
                yMin = Number((center - pad).toFixed(2));
            } else {
                const pad = range * 0.1;
                yMax = Number((yMax + pad).toFixed(2));
                yMin = Number((yMin - pad).toFixed(2));
            }
            
            // Set minimum to zero if original data values don't go below zero
            if (originalYMin >= 0 && yMin < 0) {
                yMin = 0;
            }
        }
    }

    // Draw axes with clipping path support
    function drawAxes() {
        const containerWidth = chartRef?.clientWidth || 450;
        const containerHeight = chartRef?.clientHeight || 500;
        chartWidth = containerWidth - margin.left - margin.right;
        chartHeight = containerHeight - margin.top - margin.bottom;

        const bspChannel = bspName().toLowerCase();
        const twsChannel = twsName().toLowerCase();
        const twaChannel = twaName().toLowerCase();
        const xaxisLower = props.xaxis ? props.xaxis.toLowerCase() : '';
        const isDefaultXAxis = xaxisLower === twaChannel || xaxisLower === 'twa';
        const xType = (props.xType || props.aggregate || 'AVG').toUpperCase();
        
        // Determine unit suffix based on channel name (for backward compatibility with default axes)
        const stripSpeedSuffixForAxisLabel = (channelName: string): string =>
          stripSpeedUnderscoreSuffixFromChannel(channelName);

        const xaxisLabel = props.xaxis && xaxisLower !== bspChannel && xaxisLower !== twsChannel
            ? `${stripSpeedSuffixForAxisLabel(props.xaxis).toUpperCase()} [${xType}]`
            : (xaxisLower === bspChannel || xaxisLower === 'bsp'
                ? `${stripSpeedSuffixForAxisLabel(bspChannel).toUpperCase()}${axisBracketSuffixForSpeedChannel(bspChannel, persistantStore.defaultUnits())}`
                : `${stripSpeedSuffixForAxisLabel(twsChannel).toUpperCase()}${axisBracketSuffixForSpeedChannel(twsChannel, persistantStore.defaultUnits())}`);

        d3.select(chartRef).selectAll("svg").remove();

        let svg = d3.select(chartRef)
            .append("svg")
            .attr("width", chartWidth + margin.left + margin.right)
            .attr("height", chartHeight + margin.top + margin.bottom)
            .on("dblclick", () => {
                const xType = (props.xType || props.aggregate || 'AVG').toUpperCase();
                const yType = (props.yType || props.aggregate || 'AVG').toUpperCase();
                let info = [props.xaxis, props.yaxis, props.taxis, props.filters, lastCapturedCloud, lastCapturedAggregates, props.aggregate || 'AVG', props.infoType, props.infoMessage, xType, yType];
                if (props.zoom) { info = []; }
                if (props.handleZoom) {
                    props.handleZoom(info);
                }
            })
            .on("click", (event) => {
                const target = event.target as HTMLElement | null;
                if (target && (target.tagName === 'svg' ||
                    target.classList.contains('grid') ||
                    target.classList.contains('axes') ||
                    target.tagName === 'g')) {
                    return;
                }
            })
            .on("mouseleave", () => {
                setTooltip({
                    visible: false,
                    content: "",
                    x: 0,
                    y: 0,
                });
            });

        let chart = svg.append("g")
            .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

        // Use calculated bounds for default x-axis (which include interval padding)
        let xDomainMin = xMin;
        let xDomainMax = xMax;
        if (xMin === 9999999 || xMax === -9999999 || xMin > xMax) {
            xDomainMin = 5;
            xDomainMax = 25;
        }
        
        // For default x-axis, ensure we're using the calculated bounds (which include interval padding)
        if (isDefaultXAxis && xMin !== 9999999 && xMax !== -9999999) {
            xDomainMin = xMin;
            xDomainMax = xMax;
        }
        
        xScale = d3.scaleLinear().range([0, chartWidth]).domain([xDomainMin, xDomainMax]);
        chart.append("g")
            .attr("class", "x-axis")
            .attr("transform", "translate(0," + chartHeight + ")")
            .call(d3.axisBottom(xScale));

        yScale = d3.scaleLinear().range([chartHeight, 0]).domain([yMin, yMax]);
        chart.append("g")
            .attr("class", "y-axis")
            .call(d3.axisLeft(yScale));

        svg.selectAll(".x-label, .y-label").remove();

        const yType = (props.yType || props.aggregate || 'AVG').toUpperCase();
        const yAxisLabel = `${props.yaxis.toUpperCase()} [${yType}]`;

        svg.append("text")
            .attr("class", "y-label chart-element")
            .style("text-anchor", "start")
            .attr("x", margin.left + 25)
            .attr("y", margin.top + 10)
            .attr("font-size", "16px")
            .text(yAxisLabel);

        svg.append("text")
            .attr("class", "x-label chart-element")
            .attr("text-anchor", "middle")
            .attr("transform", `translate(${margin.left + chartWidth / 2},${margin.top + chartHeight + 40})`)
            .attr("font-size", "16px")
            .text(xaxisLabel);

        chart.append("g")
            .attr("class", "grid")
            .attr("transform", "translate(0," + chartHeight + ")")
            .style("stroke-dasharray", ("3,3"))
            .call(d3.axisBottom(xScale)
                .ticks(5)
                .tickSize(-chartHeight)
                .tickFormat(() => "")
            );

        chart.append("g")
            .attr("class", "grid")
            .style("stroke-dasharray", ("3,3"))
            .call(d3.axisLeft(yScale)
                .ticks(5)
                .tickSize(-chartWidth)
                .tickFormat(() => "")
            );

        // Create clipping path for chart area (from PerfScatter)
        svg.selectAll("defs").remove();
        svg.append("defs")
            .append("clipPath")
            .attr("id", "chart-clip")
            .append("rect")
            .attr("x", margin.left)
            .attr("y", margin.top)
            .attr("width", chartWidth)
            .attr("height", chartHeight);
    }

    // Draw target spline line
    function drawSpline(data: any[]): void {
        logDebug('AdvancedScatter: drawSpline called', {
            dataLength: data?.length || 0,
            dataType: typeof data,
            isArray: Array.isArray(data),
            hasChartRef: !!chartRef,
            firstFewPoints: data?.slice(0, 3) || []
        });
        
        let chart = d3.select(chartRef).select("svg").select("g");
        if (data != undefined && data.length > 0) {
            // Use all data - clipping path will hide parts outside bounds
            let valueline = d3.line<any>()
                .curve(d3.curveMonotoneX)
                .x((d: any) => xScale(d.X))
                .y((d: any) => yScale(d.Y))
                .defined((d: any) => d.X != null && d.Y != null && !isNaN(d.X) && !isNaN(d.Y));

            const pathData = valueline(data);
            logDebug('AdvancedScatter: Target path generated', {
                pathData: pathData,
                pathLength: pathData?.length || 0,
                dataPoints: data.length,
                xScaleDomain: xScale.domain(),
                yScaleDomain: yScale.domain()
            });

            const targetPath = chart.append("path")
                .datum(data)
                .attr("d", pathData)
                .attr("class", "tgt")
                .style("fill", "none")
                .style("stroke", "#00ff7f")
                .style("stroke-width", 2)
                .style("pointer-events", "none")
                .attr("clip-path", "url(#chart-clip)");
            
            // Ensure target line is on top by raising it
            targetPath.raise();
            
            logDebug('AdvancedScatter: Target path element created', {
                elementExists: !!targetPath.node(),
                className: targetPath.attr("class")
            });
        } else {
            logError('AdvancedScatter: drawSpline called with invalid data', {
                dataLength: data?.length || 0,
                dataType: typeof data,
                isArray: Array.isArray(data),
                data: data
            });
        }
    }

    // Draw cloud area visualization (from PerfScatter, conditional on cloud prop)
    function removeCloudArea(): void {
        if (!chartRef) return;
        const svg = d3.select(chartRef).select("svg");
        if (svg.empty()) return;
        
        // Remove cloud area from multiple possible locations
        svg.selectAll(".cloud-area").remove();
        svg.selectAll("g.cloud-area").remove();
        const chartbody = svg.select("g");
        if (!chartbody.empty()) {
            chartbody.selectAll(".cloud-area").remove();
            chartbody.selectAll("g.cloud-area").remove();
        }
    }

    /**
     * Draw cloud area visualization using ONLY cloud data (1Hz data from props.cloud)
     * This function does NOT use aggregate data - it relies solely on cloud_data_r
     * which is derived from props.cloud and contains only 1Hz point data
     */
    function drawArea(data: any[]): void {
        try {
            if (!data || !Array.isArray(data) || data.length === 0) {
                return;
            }

            // This function only uses cloud data - data parameter should be cloud_data_r
            // which contains only 1Hz cloud data, not aggregates
            // Debug: Log cloud data count to verify it's 1Hz data (should be many more points than aggregates)
            logDebug('AdvancedScatter: drawArea called with cloud data', {
                totalCloudPoints: data.length,
                uniqueEventIds: new Set(data.map((d: any) => d.event_id)).size,
                pointsPerEvent: new Set(data.map((d: any) => d.event_id)).size > 0 
                    ? (data.length / new Set(data.map((d: any) => d.event_id)).size).toFixed(2) 
                    : 'N/A',
                samplePoint: data.length > 0 ? {
                    event_id: data[0].event_id,
                    X: data[0].X,
                    Y: data[0].Y,
                    Datetime: data[0].Datetime
                } : null
            });

            let chartbody = d3.select(chartRef).select("svg").select("g");
            // Increased bandwidth to create more connected, flowing contours instead of circular blobs
            let bandwidth = 15;
            if (props.zoom) {
                bandwidth = 25;
            }

            let xfiltered = data.filter((d: any) => d.X > xMin && d.X < xMax);
            let yfiltered = xfiltered.filter((d: any) => d.Y > yMin && d.Y < yMax);
            
            // Debug: Log filtered counts
            logDebug('AdvancedScatter: Cloud data after bounds filtering', {
                originalCount: data.length,
                afterXFilter: xfiltered.length,
                afterYFilter: yfiltered.length,
                xBounds: [xMin, xMax],
                yBounds: [yMin, yMax]
            });

            let densityData = d3.contourDensity<any>()
                .x(function (d: any) { return xScale(d.X); })
                .y(function (d: any) { return yScale(d.Y); })
                .size([chartWidth, chartHeight])
                .bandwidth(bandwidth)
                .thresholds(20)
                (yfiltered);

            let dExtent = d3.extent(densityData, function (p: any) { return +p.value });

            let color: d3.ScaleLinear<number, string, never>;
            if (isDark()) {
                color = d3.scaleLinear<number, string, never>()
                    .domain([dExtent[0] || 0, (dExtent[1] || 0) * 0.6])
                    // @ts-ignore
                    // .range(["#9ca3af", "#ffffff"]);
                    .range(["#9ca3af", "lightgrey"]);
            } else {
                color = d3.scaleLinear<number, string, never>()
                    .domain([dExtent[0] || 0, (dExtent[1] || 0) * 0.6])
                    // @ts-ignore
                    .range(["#f3f4f6", "#6b7280"]);
            }

            const minOpacity = 0.1;
            const maxOpacity = 0.3;

            // Remove any existing cloud before drawing new one
            chartbody.selectAll("g.cloud-area").remove();
            
            chartbody.insert("g", "g")
                .attr("class", "cloud-area")
                .style("mix-blend-mode", "multiply")
                .style("pointer-events", "none")
                .selectAll("path")
                .data(densityData)
                .enter().append("path")
                .attr("d", d3.geoPath())
                .attr("fill", function (d: any) { return color(d.value); })
                .attr("fill-opacity", function (d: any) {
                    const v0 = dExtent[0] || 0;
                    const v1 = (dExtent[1] || 0) * 0.6;
                    const t = Math.max(0, Math.min(1, (d.value - v0) / Math.max(1e-6, (v1 - v0))));
                    return minOpacity + t * (maxOpacity - minOpacity);
                })
                .attr("stroke", "none")
                .style("pointer-events", "none");
        } catch {
            // Silently fail if cloud rendering fails
        }
    }

    // Get tooltip content — date/time come pre-formatted in local time from performanceDataService / fleetPerformanceDataService
    const getTooltipContent = (point: any): string => {
        if (!point) return "";
        const dateString = point.dateStringLocal ?? "N/A";
        const timeString = point.timeStringLocal ?? "N/A";

        // Support dynamic color field (PerfScatter) - single nomenclature: resolve via mapping
        const colorByField = props.color || 'TACK';
        let colorByValue = resolveDataField(point, colorByField);
        if (colorByValue === undefined || colorByValue === null) colorByValue = 'N/A';
        if (colorByField === 'RACE' && (colorByValue === -1 || colorByValue === '-1')) colorByValue = 'TRAINING';
        if (colorByField === 'LEG' && (colorByValue === -1 || colorByValue === '-1' || String(colorByValue).toLowerCase() === 'training')) colorByValue = 'TRAINING';
        // Show source_name in uppercase in tooltip
        const isSourceField = String(colorByField).toLowerCase() === 'source_name' || String(colorByField).toLowerCase() === 'source';
        const displayColorByValue = isSourceField && typeof colorByValue === 'string' ? colorByValue.toUpperCase() : colorByValue;

        let tooltipRows = `
            <tr><td>DATE</td><td>${dateString}</td></tr>
            <tr><td>TIME</td><td>${timeString}</td></tr>`;
        
        tooltipRows += `
            <tr><td>${colorByField.toUpperCase()}</td><td>${displayColorByValue}</td></tr>
            <tr><td>${props.xaxis.toUpperCase()}</td><td>${parseFloat(point.X).toFixed(1)}</td></tr>
            <tr><td>${props.yaxis.toUpperCase()}</td><td>${parseFloat(point.Y).toFixed(1)}</td></tr>`;

        return `<table class='table-striped'>${tooltipRows}</table>`;
    };

    // Filter selection helper
    const filterSelection = (data: any[]): any[] => {
        const selected = selectedEvents();
        return data.filter((d: any) => selected.includes(d.ID));
    };

    // Compute fit data with unified logic supporting both source-based and groups-based
    // bandwidth: loess smoothing factor (e.g. 0.5), used when point count > 15
    function computeFitData(data: any[], bandwidth: number): any[] {
        const fitData: any[] = [];
        let dataForFit = data;
        const currentSelection = selectedEvents && typeof selectedEvents === 'function' ? selectedEvents() : [];
        if (currentSelection && currentSelection.length > 0) {
            const selectedIdSet = new Set(currentSelection);
            dataForFit = data.filter((d: any) => selectedIdSet.has(d.ID));
        }

        const useSourceGrouping = props.color === 'SOURCE_NAME' || props.color === 'SOURCE';
        
        // If colored by SOURCE_NAME and 'ALL' is selected, fit all points together
        if (useSourceGrouping && props.selectedSource && String(props.selectedSource).toLowerCase() === 'all') {
            if (dataForFit.length > 0) {
                const xyValues = dataForFit.map((d: any) => ({ x: d.X, y: d.Y })).sort((a: any, b: any) => a.x - b.x);
                let fitValues: Array<{ x: number; y: number }>;
                if (dataForFit.length > 15) {
                    const loess = regressionLoess().x((d: any) => d.x).y((d: any) => d.y).bandwidth(bandwidth);
                    fitValues = loess(xyValues).map(([x, y]: [number, number]) => ({ x, y }));
                } else {
                    const log = regressionLog().x((d: any) => d.x).y((d: any) => d.y);
                    fitValues = log(xyValues).map(([x, y]: [number, number]) => ({ x, y }));
                }
                fitData.push({
                    group: 'ALL',
                    color: 'lightgrey',
                    fitValues,
                    pointCount: dataForFit.length,
                });
            }
            return fitData;
        }

        // If colored by SOURCE_NAME, use source-based grouping
        if (useSourceGrouping) {
            const sourceGroups: Record<string, any[]> = {};
            dataForFit.forEach((d: any) => {
                const key = d.source_name || d.sourceName || d.source || d.SOURCE || d.SOURCE_NAME || 'unknown';
                const normKey = String(key).toLowerCase();
                if (!sourceGroups[normKey]) {
                    sourceGroups[normKey] = [];
                }
                sourceGroups[normKey].push(d);
            });

            Object.keys(sourceGroups).forEach((normKey: string) => {
                const groupData = sourceGroups[normKey];
                if (groupData.length > 0) {
                    const xyValues = groupData.map((d: any) => ({ x: d.X, y: d.Y })).sort((a: any, b: any) => a.x - b.x);
                    let fitValues: Array<{ x: number; y: number }>;
                    if (groupData.length > 15) {
                        const loess = regressionLoess().x((d: any) => d.x).y((d: any) => d.y).bandwidth(bandwidth);
                        fitValues = loess(xyValues).map(([x, y]: [number, number]) => ({ x, y }));
                    } else {
                        const log = regressionLog().x((d: any) => d.x).y((d: any) => d.y);
                        fitValues = log(xyValues).map(([x, y]: [number, number]) => ({ x, y }));
                    }
                    const displayName = groupData[0].SOURCE_NAME || groupData[0].sourceName || groupData[0].source || groupData[0].source_name || normKey || 'Unknown';
                    const scale = props.colorScale;
                    const color = scale && typeof scale === 'function' ? scale(normKey) : getColor({ source_name: normKey });
                    fitData.push({
                        group: displayName,
                        color: color,
                        fitValues,
                        pointCount: groupData.length,
                    });
                }
            });
        } else {
            // For other color fields, use groups-based grouping
            if (props.groups && Array.isArray(props.groups) && props.groups.length > 0 && props.color) {
                const colorField = props.color;
                props.groups.forEach((group: { name: string; color: string }) => {
                    const groupData = dataForFit.filter((d: any) => {
                        const value = resolveDataField(d, colorField);
                        const valueStr = value !== undefined && value !== null ? String(value) : null;
                        const groupNameStr = String(group.name);
                        if (valueStr === groupNameStr) return true;
                        const valueNum = Number(valueStr);
                        const groupNum = Number(groupNameStr);
                        if (!isNaN(valueNum) && !isNaN(groupNum) && valueNum === groupNum) return true;
                        if (valueStr && groupNameStr && valueStr.toLowerCase() === groupNameStr.toLowerCase()) return true;
                        return false;
                    });
                    
                    if (groupData.length > 0) {
                        const xyValues = groupData.map((d: any) => ({ x: d.X, y: d.Y })).sort((a: any, b: any) => a.x - b.x);
                        let fitValues: Array<{ x: number; y: number }>;
                        if (groupData.length > 15) {
                            const loess = regressionLoess().x((d: any) => d.x).y((d: any) => d.y).bandwidth(bandwidth);
                            fitValues = loess(xyValues).map(([x, y]: [number, number]) => ({ x, y }));
                        } else {
                            const log = regressionLog().x((d: any) => d.x).y((d: any) => d.y);
                            fitValues = log(xyValues).map(([x, y]: [number, number]) => ({ x, y }));
                        }
                        fitData.push({
                            group: group.name,
                            color: group.color,
                            fitValues,
                            pointCount: groupData.length,
                        });
                    }
                });
            }
        }

        return fitData;
    }

    /**
     * Clip a polyline to axis bounds in data space. Returns one or more segments
     * that lie inside [xMin, xMax] x [yMin, yMax], with intersection points at edges.
     */
    function clipPolylineToBounds(
        points: Array<{ x: number; y: number }>,
        xMin: number,
        xMax: number,
        yMin: number,
        yMax: number
    ): Array<Array<{ x: number; y: number }>> {
        if (points.length === 0) return [];
        const segments: Array<Array<{ x: number; y: number }>> = [];
        let current: Array<{ x: number; y: number }> = [];

        const inside = (p: { x: number; y: number }) =>
            p.x >= xMin && p.x <= xMax && p.y >= yMin && p.y <= yMax;

        // Clip segment (a,b) to rect; returns 0 or 1 segment (Liang-Barsky).
        // t_enter = max of entering t values, t_exit = min of exiting t values.
        const clipSegment = (
            a: { x: number; y: number },
            b: { x: number; y: number }
        ): Array<{ x: number; y: number }> | null => {
            let tEnter = 0, tExit = 1;
            const dx = b.x - a.x, dy = b.y - a.y;

            const clipEdge = (p: number, q: number): boolean => {
                if (p === 0) {
                    if (q < 0) return false; // outside and parallel
                    return true;
                }
                const t = q / p;
                if (p < 0) {
                    if (t > tExit) return false;
                    if (t > tEnter) tEnter = t;
                } else {
                    if (t < tEnter) return false;
                    if (t < tExit) tExit = t;
                }
                return true;
            };

            if (!clipEdge(-dx, a.x - xMin)) return null;
            if (!clipEdge(dx, xMax - a.x)) return null;
            if (!clipEdge(-dy, a.y - yMin)) return null;
            if (!clipEdge(dy, yMax - a.y)) return null;

            if (tEnter <= tExit) {
                const p0 = { x: a.x + tEnter * dx, y: a.y + tEnter * dy };
                const p1 = { x: a.x + tExit * dx, y: a.y + tExit * dy };
                return [p0, p1];
            }
            return null;
        };

        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (inside(p)) {
                if (current.length === 0 && i > 0) {
                    const prev = points[i - 1];
                    const clipped = clipSegment(prev, p);
                    if (clipped && clipped.length >= 1) current.push(clipped[0]);
                }
                current.push(p);
            } else {
                if (current.length > 0) {
                    const prev = points[i - 1];
                    const clipped = clipSegment(prev, p);
                    // Segment (prev,p) goes inside->outside; clipped is [prev, exit], add exit point
                    if (clipped && clipped.length >= 2) current.push(clipped[1]);
                    segments.push(current);
                    current = [];
                }
            }
        }
        if (current.length > 0) segments.push(current);
        return segments;
    }

    /**
     * Schedules drawFit to run after the current turn, so clearing selection doesn't block the UI
     * while recomputing fits on the full dataset. Clears existing fit lines immediately.
     */
    let pendingFitTimerId: ReturnType<typeof setTimeout> | null = null;
    const scheduleDrawFit = () => {
        if (!props.zoom || !chartRef?.isConnected) return;
        const chart = d3.select(chartRef).select("svg").select("g");
        if (chart.node()) chart.selectAll(".fit").remove();
        if (pendingFitTimerId != null) clearTimeout(pendingFitTimerId);
        pendingFitTimerId = setTimeout(() => {
            pendingFitTimerId = null;
            if (!isCleaningUp && chartRef?.isConnected && props.zoom) drawFit();
        }, 0);
    };

    // Draw fit lines (trimmed to current x/y axis bounds)
    const drawFit = () => {
        // Prevent execution if component is cleaning up or not connected
        if (isCleaningUp || !chartRef || !chartRef.isConnected) return;
        if (!props.zoom) return;
        const chart = d3.select(chartRef).select("svg").select("g");
        if (!chart.node()) return; // Chart not ready
        chart.selectAll(".fit").remove();
        const fitDataComputed = computeFitData(filtered(), loessBandwidth());
        const [xMinDom, xMaxDom] = xScale.domain();
        const [yMinDom, yMaxDom] = yScale.domain();
        const lineGenerator = d3.line<{ x: number; y: number }>()
            .curve(d3.curveMonotoneX)
            .x((d: { x: number; y: number }) => xScale(d.x))
            .y((d: { x: number; y: number }) => yScale(d.y));
        fitDataComputed.forEach(({ color, fitValues }: { color: string; fitValues: Array<{ x: number; y: number }> }) => {
            // Double-check before appending (component might have been unmounted during computation)
            if (isCleaningUp || !chartRef || !chartRef.isConnected) return;
            const segments = clipPolylineToBounds(fitValues, xMinDom, xMaxDom, yMinDom, yMaxDom);
            segments.forEach((segment) => {
                if (segment.length < 2) return;
                chart.append("path")
                    .datum(segment)
                    .attr("d", lineGenerator)
                    .attr("class", "fit")
                    .style("stroke", color)
                    .style("stroke-width", 2)
                    .style("pointer-events", "none");
            });
        });
        if (!isCleaningUp && chartRef && chartRef.isConnected) {
            setFitDataVersion(v => v + 1);
            setFitData(fitDataComputed);
        }
    };

    // Draw scatter points - simplified but complete version
    function drawScatter(data: any[]): void {
        try {
            let svg = d3.select(chartRef).select("svg");
            let chartbody = d3.select(chartRef).select("svg").select("g");

            const setMouseID = props.setMouseID;

            let lassoInstance: any = null;

            getFillColor = (d: any) => getColor(d);
            const strokeColor = getThemeStrokeColor();
            getStrokeColor = (d: any) => strokeColor;

            const maxPoints = 2000;
            let processedData = data;
            if (data.length > maxPoints) {
                const step = Math.ceil(data.length / maxPoints);
                processedData = data.filter((_: any, index: number) => index % step === 0);
            }

            const isHighlighted = (d: any) => {
                const selected = selectedEvents();
                return selected && selected.length > 0 && d.ID !== undefined && d.ID !== null && selected.includes(d.ID);
            };

            const data_stbd = processedData.filter((d) => (resolveDataField(d, 'TACK') ?? d.tack) === 'STBD');
            const data_stbd_regular = data_stbd.filter((d) => !isHighlighted(d));
            const data_stbd_highlighted = data_stbd.filter((d) => isHighlighted(d));
            const data_port = processedData.filter((d) => (resolveDataField(d, 'TACK') ?? d.tack) === 'PORT');
            const data_port_regular = data_port.filter((d) => !isHighlighted(d));
            const data_port_highlighted = data_port.filter((d) => isHighlighted(d));

            // Helper to update hover state
            function updateAllChartsHover(hoverID: number | null): void {
                const hasSVG = chartRef && d3.select(chartRef).select("svg").node();
                if (!chartRef || (!isVisible() && !hasSVG && !isLassoActive)) return;
                const selected = selectedEvents();
                const hasSelection = selected.length > 0;
                const scatterPoints = d3.select(chartRef).selectAll(".scatter");
                scatterPoints.filter("circle")
                    .transition().duration(200)
                    .attr("r", (d: any) => {
                        if (!d || d.ID === undefined || d.ID === null) return 5;
                        const isSelected = hasSelection && selected.includes(d.ID);
                        const isHovered = hoverID && d.ID === hoverID;
                        if (isHovered) return 10;
                        return hasSelection ? (isSelected ? 6 : 4) : 5;
                    });
                scatterPoints.filter("rect")
                    .transition().duration(200)
                    .attr("width", (d: any) => {
                        if (!d || d.ID === undefined || d.ID === null) return 8.25;
                        const isSelected = hasSelection && selected.includes(d.ID);
                        const isHovered = hoverID && d.ID === hoverID;
                        if (isHovered) return 14;
                        return hasSelection ? (isSelected ? 11 : 6) : 8.25;
                    })
                    .attr("height", (d: any) => {
                        if (!d || d.ID === undefined || d.ID === null) return 8.25;
                        const isSelected = hasSelection && selected.includes(d.ID);
                        const isHovered = hoverID && d.ID === hoverID;
                        if (isHovered) return 14;
                        return hasSelection ? (isSelected ? 11 : 6) : 8.25;
                    });
            }

            const getTooltipPosition = (event: MouseEvent) => {
                try {
                    if (!containerRef) return { x: 0, y: 0 };
                    const rect = containerRef.getBoundingClientRect();
                    const relX = event.clientX - rect.left;
                    const relY = event.clientY - rect.top;
                    const scrollX = containerRef.scrollLeft || 0;
                    const scrollY = containerRef.scrollTop || 0;
                    return { x: relX - 100 + scrollX, y: relY + scrollY };
                } catch {
                    return { x: 0, y: 0 };
                }
            };

            const shouldDisableHover = () => isLassoActive || isComputingSelection;

            const mouseover = (event: MouseEvent, d: any) => {
                if (shouldDisableHover()) return;
                if (setMouseID) setMouseID(d.ID);
                updateAllChartsHover(d.ID);
                const tooltipContent = getTooltipContent(d);
                const position = getTooltipPosition(event);
                setTooltip({ visible: true, content: tooltipContent, x: position.x, y: position.y });
            };

            const mouseout = () => {
                if (shouldDisableHover()) return;
                if (setMouseID) setMouseID(null);
                updateAllChartsHover(null);
                setTooltip({ visible: false, content: "", x: 0, y: 0 });
            };

            const click = function (event: MouseEvent, d: any) {
                event.stopPropagation();
                event.preventDefault();
                if (isLassoActive && lassoInstance) {
                    const drawnCoords = lassoInstance.getDrawnCoords();
                    if (drawnCoords && drawnCoords.length >= 2) return;
                }
                if (shouldDisableHover() || !allowclick) return;
                allowclick = false;
                const list = selectedEvents();
                const exists = list.includes(d.ID);
                if (exists) {
                    setSelectedEvents(list.filter(id => id !== d.ID));
                } else {
                    setSelectedEvents([...list, d.ID]);
                }
                setFiltered(filterSelection(data));
                setTriggerSelection(true);
                setHasSelection(list.length > 0);
                allowclick = true;
            };

            storedMouseover = mouseover;
            storedMouseout = mouseout;
            storedClick = click;

            // Draw regular points first, then highlighted points on top
            chartbody.append("g").selectAll("circle").data(data_stbd_regular).enter().append("circle")
                .attr("class", "scatter")
                .style("stroke", strokeColor)
                .style("fill", (d: any) => getFillColor?.(d) || "lightgrey")
                .attr("r", 5)
                .attr("cx", (d: any) => xScale(d.X))
                .attr("cy", (d: any) => yScale(d.Y));

            chartbody.append("g").selectAll("rect").data(data_port_regular).enter().append("rect")
                .attr("class", "scatter")
                .style("stroke", strokeColor)
                .style("fill", (d: any) => getFillColor?.(d) || "lightgrey")
                .attr("width", 8.25).attr("height", 8.25)
                .attr("x", (d: any) => xScale(d.X))
                .attr("y", (d: any) => yScale(d.Y));

            chartbody.append("g").selectAll("circle").data(data_stbd_highlighted).enter().append("circle")
                .attr("class", "scatter")
                .style("stroke", strokeColor)
                .style("fill", (d: any) => getFillColor?.(d) || "lightgrey")
                .attr("r", 6)
                .attr("cx", (d: any) => xScale(d.X))
                .attr("cy", (d: any) => yScale(d.Y));

            chartbody.append("g").selectAll("rect").data(data_port_highlighted).enter().append("rect")
                .attr("class", "scatter")
                .style("stroke", strokeColor)
                .style("fill", (d: any) => getFillColor?.(d) || "lightgrey")
                .attr("width", 11).attr("height", 11)
                .attr("x", (d: any) => xScale(d.X))
                .attr("y", (d: any) => yScale(d.Y));

            let points = chartbody.selectAll(".scatter");
            if (isVisible() && storedMouseover && storedMouseout && storedClick) {
                points.on("mouseover", storedMouseover).on("mouseout", storedMouseout).on("click", storedClick);
                listenersAttached = true;
            }

            // Setup lasso
            try {
                if (!svg || !svg.node()) return;
                const lassoInstance = lasso()
                    .closePathSelect(true)
                    // @ts-ignore
                    .closePathDistance(75)
                    .items(points)
                    .targetArea(svg)
                    .skipDragCalculations(true)
                    .on('start', () => {
                        isLassoActive = true;
                        isComputingSelection = false;
                        if (setMouseID) setMouseID(null);
                        updateAllChartsHover(null);
                        setTooltip({ visible: false, content: "", x: 0, y: 0 });
                    })
                    .on('end', async () => {
                        isLassoActive = false;
                        const drawnCoords = lassoInstance.getDrawnCoords();
                        if (!drawnCoords || drawnCoords.length < 3) return;
                        const pointData = points.data()
                            .filter((d: any) => d.ID !== undefined && d.ID !== null)
                            .map((d: any) => {
                                const node = points.nodes().find((n: any) => {
                                    const nodeData = d3.select(n).datum() as any;
                                    return nodeData && nodeData.ID === d.ID;
                                });
                                if (node) {
                                    const element = node as Element;
                                    const box = element.getBoundingClientRect();
                                    return {
                                        id: String(d.ID),
                                        x: box.left + box.width / 2,
                                        y: box.top + box.height / 2
                                    };
                                }
                                return null;
                            }).filter((p: any) => p !== null);
                        if (pointData.length === 0) return;
                        isComputingSelection = true;
                        setIsComputingLassoSelection(true);
                        try {
                            if (!lassoWorker) {
                                // Use ?worker import - Vite bundles this correctly in production
                                lassoWorker = new LassoSelectionWorker();
                                if (!lassoWorker) throw new Error('Failed to create lasso worker');
                            }
                            const messageId = `lasso-selection-${Date.now()}-${Math.random()}`;
                            const selectedIds = await new Promise<string[]>((resolve, reject) => {
                                const timeout = setTimeout(() => {
                                    if (lassoWorker) lassoWorker.removeEventListener('message', handleMessage);
                                    reject(new Error('Lasso selection computation timeout'));
                                }, 10000);
                                const handleMessage = (event: MessageEvent) => {
                                    if (event.data.id === messageId) {
                                        clearTimeout(timeout);
                                        if (lassoWorker) lassoWorker.removeEventListener('message', handleMessage);
                                        if (event.data.type === 'success' && event.data.result) {
                                            resolve(event.data.result.selectedIds);
                                        } else {
                                            reject(new Error(event.data.error || 'Unknown error'));
                                        }
                                    }
                                };
                                if (lassoWorker) {
                                    lassoWorker.addEventListener('message', handleMessage);
                                    lassoWorker.postMessage({
                                        id: messageId,
                                        type: 'COMPUTE_LASSO_SELECTION',
                                        data: { points: pointData, polygon: drawnCoords },
                                        timestamp: Date.now()
                                    });
                                } else {
                                    clearTimeout(timeout);
                                    reject(new Error('Worker not available'));
                                }
                            });
                            isComputingSelection = false;
                            setIsComputingLassoSelection(false);
                            if (selectedIds.length > 0) {
                                const numericIds = selectedIds.map(id => Number(id)).filter(id => !isNaN(id));
                                const currentSelected = selectedEvents();
                                const currentSelectedIds = new Set(currentSelected);
                                const allIds = new Set([...currentSelectedIds, ...numericIds]);
                                setSelectedEvents(Array.from(allIds).map(id => Number(id)));
                                setFiltered(filterSelection(data));
                                setTriggerSelection(true);
                                setHasSelection(allIds.size > 0);
                            }
                        } catch (error: any) {
                            isComputingSelection = false;
                            setIsComputingLassoSelection(false);
                            logError('Error computing lasso selection:', error);
                        }
                    });
                svg.call(lassoInstance);
                const allScatterPoints = chartbody.selectAll(".scatter");
                allScatterPoints.on('mousedown', function (event: MouseEvent) {
                    event.stopPropagation();
                });
            } catch (error: any) {
                logError('Error setting up lasso:', error);
            }
        } catch (error: any) {
            logError('Error in drawScatter:', error);
        }
    }

    // Main draw chart function
    const drawChart = (capturedAggregates?: any[], capturedCloud?: any[]) => {
        if (!chartRef || !chartRef.isConnected) return;
        const hasSVG = chartRef && d3.select(chartRef).select("svg").node();
        if (!isVisible() && hasSVG && chartRef) {
            const rect = chartRef.getBoundingClientRect();
            const isInViewport = rect.top < window.innerHeight && rect.bottom > 0;
            if (!isInViewport) return;
        }

        d3.select(chartRef).selectAll("*").remove();
        isLassoActive = false;
        listenersAttached = false;

        const aggregatesToUse = capturedAggregates !== undefined ? capturedAggregates : (lastCapturedAggregates !== undefined ? lastCapturedAggregates : []);
        // Always use current props.cloud if capturedCloud is not provided - never use stale lastCapturedCloud
        // This ensures we always have the correct filtered cloud data (upwind or downwind) from Performance.tsx
        const cloudToUse = capturedCloud !== undefined ? capturedCloud : (props.cloud && Array.isArray(props.cloud) ? props.cloud : []);

        let aggregate_data = [];
        let cloud_data = [];
        let target_data = [];

        // If we have separate aggregate types, skip the old filtering logic - we'll filter them separately below
        // Otherwise, use the old filtering logic for backward compatibility
        if (!(props.aggregatesAVG || props.aggregatesSTD || props.aggregatesAAV)) {
            if (props.filters && props.filters.length > 0) {
                props.filters.forEach((filter: string) => {
                    if (filter == 'upwind') {
                        aggregate_data = filterData(aggregatesToUse, "UW", "BOTH");
                        // props.cloud is already filtered by Performance.tsx, so use it directly without re-filtering
                        cloud_data = (cloudToUse && Array.isArray(cloudToUse) && cloudToUse.length > 0) ? cloudToUse : [];
                        target_data = props.targets?.['UPWIND'] || [];
                    } else if (filter == 'downwind') {
                        aggregate_data = filterData(aggregatesToUse, "DW", "BOTH");
                        // props.cloud is already filtered by Performance.tsx, so use it directly without re-filtering
                        cloud_data = (cloudToUse && Array.isArray(cloudToUse) && cloudToUse.length > 0) ? cloudToUse : [];
                        target_data = props.targets?.['DOWNWIND'] || [];
                    }
                });
            } else {
                // When filters are empty, check uwDw prop for aggregate filtering
                // NOTE: props.cloud is already filtered by Performance.tsx based on UwDw toggle,
                // so we should NOT filter it again here - just use it directly
                if (props.uwDw === 'UPWIND') {
                    aggregate_data = filterData(aggregatesToUse, "UW", "BOTH");
                    // Use cloud directly - it's already filtered to upwind by Performance.tsx
                    cloud_data = (cloudToUse && Array.isArray(cloudToUse) && cloudToUse.length > 0) ? cloudToUse : [];
                    target_data = props.targets?.['UPWIND'] || props.targets || [];
                } else if (props.uwDw === 'DOWNWIND') {
                    aggregate_data = filterData(aggregatesToUse, "DW", "BOTH");
                    // Use cloud directly - it's already filtered to downwind by Performance.tsx
                    cloud_data = (cloudToUse && Array.isArray(cloudToUse) && cloudToUse.length > 0) ? cloudToUse : [];
                    target_data = props.targets?.['DOWNWIND'] || props.targets || [];
                } else {
                    aggregate_data = filterData(aggregatesToUse, "NONE", "BOTH");
                    // Use cloud directly - it's already filtered by Performance.tsx
                    cloud_data = (cloudToUse && Array.isArray(cloudToUse) && cloudToUse.length > 0) ? cloudToUse : [];
                    target_data = props.targets || [];
                }
            }
        } else {
            // Separate aggregate types provided - set target_data but skip aggregate_data filtering (will be done below)
            if (props.filters && props.filters.length > 0) {
                props.filters.forEach((filter: string) => {
                    if (filter == 'upwind') {
                        target_data = props.targets?.['UPWIND'] || [];
                    } else if (filter == 'downwind') {
                        target_data = props.targets?.['DOWNWIND'] || [];
                    }
                });
            } else {
                if (props.uwDw === 'UPWIND') {
                    target_data = props.targets?.['UPWIND'] || props.targets || [];
                } else if (props.uwDw === 'DOWNWIND') {
                    target_data = props.targets?.['DOWNWIND'] || props.targets || [];
                } else {
                    target_data = props.targets || [];
                }
            }
            // Cloud data is already filtered by Performance.tsx
            cloud_data = (cloudToUse && Array.isArray(cloudToUse) && cloudToUse.length > 0) ? cloudToUse : [];
        }

        // Target data structure: object with field names as keys (often `*.speedUnit_target` from cloud)
        // Only use targets if explicitly specified in chart configuration (taxis prop must be provided)
        let target_data_array: any[] = [];
        // Skip target lookup if taxis is empty (no target specified in chart configuration)
        if (!props.taxis || props.taxis.trim() === '') {
            // No target specified, skip target lookup
        } else if (target_data && typeof target_data === 'object' && !Array.isArray(target_data)) {
            // Target data is an object, use taxis prop directly as the key (it comes from chart configuration)
            const taxisField = props.taxis;
            const availableKeys = Object.keys(target_data);
            
            logDebug('AdvancedScatter: Looking for target data field', {
                taxisField,
                availableKeys,
                targetDataType: typeof target_data,
                isArray: Array.isArray(target_data)
            });
            
            // Try exact match first (chart configuration specifies the exact field name)
            if (target_data[taxisField] && Array.isArray(target_data[taxisField])) {
                target_data_array = target_data[taxisField];
                logDebug('AdvancedScatter: Found target data with exact match', { key: taxisField, count: target_data_array.length });
            } else {
                // Try case-insensitive match (in case of case differences)
                const matchingKey = availableKeys.find(key => key.toLowerCase() === taxisField.toLowerCase());
                if (matchingKey && Array.isArray(target_data[matchingKey])) {
                    target_data_array = target_data[matchingKey];
                    logDebug('AdvancedScatter: Found target data with case-insensitive match', { key: matchingKey, searched: taxisField, count: target_data_array.length });
                } else {
                    logError('AdvancedScatter: Could not find target data field', {
                        taxisField,
                        availableKeys,
                        firstFewKeys: availableKeys.slice(0, 10),
                        firstFewValues: availableKeys.slice(0, 3).map(k => ({ key: k, isArray: Array.isArray(target_data[k]), length: Array.isArray(target_data[k]) ? target_data[k].length : 'N/A' }))
                    });
                }
            }
        } else if (Array.isArray(target_data)) {
            // Target data is already an array
            target_data_array = target_data;
            logDebug('AdvancedScatter: Target data is already an array', { count: target_data_array.length });
        } else if (target_data) {
            logError('AdvancedScatter: Target data is not an object or array', {
                targetDataType: typeof target_data,
                isArray: Array.isArray(target_data),
                value: target_data
            });
        }

        // Update the map of Twa_deg_avg from AVG aggregates for filtering STD/AAV aggregates
        // This must be updated before filtering so getTwa can use it
        avgTwaDegAvgMap.clear();
        if (props.aggregatesAVG && Array.isArray(props.aggregatesAVG)) {
            props.aggregatesAVG.forEach((d: any) => {
                const eventId = d.event_id;
                if (eventId !== undefined && eventId !== null) {
                    const twaDegAvg = d.Twa_deg_avg ?? d.twa_deg_avg;
                    if (twaDegAvg !== undefined && twaDegAvg !== null && !isNaN(Number(twaDegAvg))) {
                        avgTwaDegAvgMap.set(eventId, Number(twaDegAvg));
                    }
                }
            });
        }

        // Use separate aggregate data for x-axis and y-axis if available
        const xType = (props.xType || props.aggregate || 'AVG').toUpperCase();
        const yType = (props.yType || props.aggregate || 'AVG').toUpperCase();
        
        // Filter separate aggregate types directly if available, otherwise use filtered aggregate_data
        let xFilteredData = aggregate_data;
        let yFilteredData = aggregate_data;
        
        if (props.aggregatesAVG || props.aggregatesSTD || props.aggregatesAAV) {
            // We have separate aggregate types - filter each one directly
            const aggregatesByType: { [key: string]: any[] } = {
                AVG: props.aggregatesAVG || [],
                STD: props.aggregatesSTD || [],
                AAV: props.aggregatesAAV || []
            };
            
            // Determine filter direction
            let filterDirection = "NONE";
            if (props.filters && props.filters.length > 0) {
                props.filters.forEach((filter: string) => {
                    if (filter == 'upwind') filterDirection = "UW";
                    else if (filter == 'downwind') filterDirection = "DW";
                });
            } else {
                if (props.uwDw === 'UPWIND') filterDirection = "UW";
                else if (props.uwDw === 'DOWNWIND') filterDirection = "DW";
            }
            
            // Filter each aggregate type separately
            const filteredAggregatesByType: { [key: string]: any[] } = {
                AVG: aggregatesByType.AVG.length > 0 ? filterData(aggregatesByType.AVG, filterDirection, "BOTH") : [],
                STD: aggregatesByType.STD.length > 0 ? filterData(aggregatesByType.STD, filterDirection, "BOTH") : [],
                AAV: aggregatesByType.AAV.length > 0 ? filterData(aggregatesByType.AAV, filterDirection, "BOTH") : []
            };
            
            // Debug logging for downwind filtering
            if (filterDirection === "DW" && (xType !== 'AVG' || yType !== 'AVG')) {
                // Test getTwa on a sample STD/AAV point to see what value it returns
                const sampleSTD = aggregatesByType.STD.length > 0 ? aggregatesByType.STD[0] : null;
                const sampleAAV = aggregatesByType.AAV.length > 0 ? aggregatesByType.AAV[0] : null;
                const testTwaSTD = sampleSTD ? getTwa(sampleSTD) : null;
                const testTwaAAV = sampleAAV ? getTwa(sampleAAV) : null;
                
                logDebug('[AdvancedScatter] Downwind filtering debug:', {
                    xType,
                    yType,
                    filterDirection,
                    beforeFilter: {
                        AVG: aggregatesByType.AVG.length,
                        STD: aggregatesByType.STD.length,
                        AAV: aggregatesByType.AAV.length
                    },
                    afterFilter: {
                        AVG: filteredAggregatesByType.AVG.length,
                        STD: filteredAggregatesByType.STD.length,
                        AAV: filteredAggregatesByType.AAV.length
                    },
                    sampleSTD: sampleSTD ? {
                        event_id: sampleSTD.event_id,
                        Twa_deg_avg: sampleSTD.Twa_deg_avg ?? sampleSTD.twa_deg_avg,
                        Twa_deg: sampleSTD.Twa_deg ?? sampleSTD.twa_deg,
                        getTwa_result: testTwaSTD,
                        isDownwind: testTwaSTD !== null ? Math.abs(testTwaSTD) > 90 : false,
                        allTwaKeys: Object.keys(sampleSTD).filter(k => k.toLowerCase().includes('twa'))
                    } : null,
                    sampleAAV: sampleAAV ? {
                        event_id: sampleAAV.event_id,
                        Twa_deg_avg: sampleAAV.Twa_deg_avg ?? sampleAAV.twa_deg_avg,
                        Twa_deg: sampleAAV.Twa_deg ?? sampleAAV.twa_deg,
                        getTwa_result: testTwaAAV,
                        isDownwind: testTwaAAV !== null ? Math.abs(testTwaAAV) > 90 : false,
                        allTwaKeys: Object.keys(sampleAAV).filter(k => k.toLowerCase().includes('twa'))
                    } : null
                });
            }
            
            // Use filtered data for x and y axes based on their types
            xFilteredData = filteredAggregatesByType[xType] || [];
            yFilteredData = filteredAggregatesByType[yType] || [];
            
            // When using separate aggregate types, pass empty array as collection since we're using xFilteredData/yFilteredData
            var aggregate_data_r = reduceData([], props.xaxis, props.yaxis, xFilteredData, yFilteredData);
            
            // Debug logging for reduceData result
            if (filterDirection === "DW" && (xType !== 'AVG' || yType !== 'AVG')) {
                logDebug('[AdvancedScatter] After reduceData:', {
                    xType,
                    yType,
                    xFilteredDataLength: xFilteredData.length,
                    yFilteredDataLength: yFilteredData.length,
                    reducedDataLength: aggregate_data_r.length,
                    xaxis: props.xaxis,
                    yaxis: props.yaxis
                });
            }
        } else {
            // No separate aggregate types - use the standard flow
            var aggregate_data_r = reduceData(aggregate_data, props.xaxis, props.yaxis, xFilteredData, yFilteredData);
        }
        
        // Create cloud_data_r from ONLY cloud data (props.cloud) - this contains only 1Hz point data, NOT aggregates
        // cloud_data comes from props.cloud which is already filtered 1Hz data from Performance.tsx
        var cloud_data_r = cloud_data && cloud_data.length > 0 ? reduceData(cloud_data, props.xaxis, props.yaxis) : [];
        
        // Debug: Log cloud data after reduceData
        if (cloud_data && cloud_data.length > 0) {
            logDebug('AdvancedScatter: Cloud data after reduceData', {
                inputCount: cloud_data.length,
                outputCount: cloud_data_r.length,
                xaxis: props.xaxis,
                yaxis: props.yaxis,
                reductionRatio: cloud_data.length > 0 ? (cloud_data_r.length / cloud_data.length).toFixed(2) : 'N/A'
            });
        }
        // Only process targets if taxis is specified (target explicitly configured in chart)
        var target_data_r: any[] = [];
        if (props.taxis && props.taxis.trim() !== '' && target_data_array.length > 0) {
            target_data_r = reduceTargets(target_data_array, props.xaxis.toLowerCase(), props.taxis);
        } else {
            // No target specified, skip target processing
        }

        // Debug logging for data processing
        if (aggregate_data_r.length === 0 && aggregate_data.length > 0) {
            logDebug('AdvancedScatter: reduceData returned empty array', {
                inputCount: aggregate_data.length,
                xaxis: props.xaxis,
                yaxis: props.yaxis,
                firstItem: aggregate_data[0] ? Object.keys(aggregate_data[0]) : []
            });
        }

        // Use cloud data for bounds if available, otherwise use aggregate data
        if (cloud_data_r && cloud_data_r.length > 0) {
            getYBounds([cloud_data_r]);
            getXBounds([cloud_data_r], cloud_data_r, aggregate_data_r);
        } else if (aggregate_data_r && aggregate_data_r.length > 0) {
            getXBounds([aggregate_data_r], cloud_data_r, aggregate_data_r);
            getYBounds([aggregate_data_r]);
        } else {
            // No data to draw - log warning
            logDebug('AdvancedScatter: No data to draw', {
                aggregateInput: aggregatesToUse?.length || 0,
                aggregateFiltered: aggregate_data.length,
                aggregateReduced: aggregate_data_r.length,
                cloudInput: cloudToUse?.length || 0,
                cloudFiltered: cloud_data.length,
                cloudReduced: cloud_data_r.length
            });
            return; // Exit early if no data
        }
        
        drawAxes();

        // ============================================================================
        // CLOUD FUNCTIONALITY - TEMPORARILY DISABLED
        // ============================================================================
        // TO RESTORE CLOUD VISUALIZATION:
        // 1. Uncomment the code block below
        // 2. Remove or comment out the removeCloudArea() call
        // 3. Ensure cloud data fetching is enabled in Performance.tsx (see notes there)
        // 4. Ensure cloud buttons are visible in PerfSettings.tsx (see notes there)
        //
        // NOTES:
        // - Cloud visualization uses ONLY cloud_data_r (1Hz data from props.cloud)
        // - Cloud data should NOT include aggregates (1 point per event_id)
        // - Bandwidth settings: normal=15, zoom=25 (adjust for contour smoothness)
        // - Thresholds: 20 (adjust for number of contour levels)
        // - Opacity: min=0.25, max=0.6 (in drawArea function)
        // - Fill colors: dark mode (#9ca3af to lightgrey), light mode (#f3f4f6 to #6b7280)
        // ============================================================================
        // Draw cloud area first (background layer) - uses ONLY cloud_data_r (1Hz data, no aggregates)
        // if (cloud_data_r && cloud_data_r.length > 0) {
        //     drawArea(cloud_data_r);
        // } else {
        //     // Explicitly remove cloud if no cloud data
        //     removeCloudArea();
        // }
        // Always remove cloud for now
        removeCloudArea();
        // Draw scatter points (middle layer)
        drawScatter(aggregate_data_r);
        // Draw target line last (top layer - after cloud and scatter points) - only if target is specified
        if (target_data_r && target_data_r.length > 0) {
            drawSpline(target_data_r);
        }

        setFiltered(aggregate_data_r);

        if (props.zoom) {
            scheduleDrawFit();
        }

        const selected = selectedEvents();
        if (selected && selected.length > 0) {
            d3.selectAll(".scatter").each(function (d: any) {
                if (selected.includes(d.ID)) {
                    d3.select(this).style('opacity', 1);
                } else {
                    d3.select(this).style('opacity', 0.2);
                }
            });
        }
    };

    // Partial redraw for visibility changes (from FleetScatter)
    function drawDataElementsOnly(capturedAggregates?: any[], capturedCloud?: any[]): void {
        if (!chartRef || !chartRef.isConnected) return;
        const svg = d3.select(chartRef).select("svg");
        if (!svg.node()) {
            drawChart(capturedAggregates, capturedCloud);
            return;
        }
        const xAxisSelection = svg.select(".x-axis");
        const yAxisSelection = svg.select(".y-axis");
        if (xAxisSelection.empty() || yAxisSelection.empty()) {
            drawChart(capturedAggregates, capturedCloud);
            return;
        }

        const aggregatesToUse = capturedAggregates !== undefined ? capturedAggregates : (lastCapturedAggregates !== undefined ? lastCapturedAggregates : []);
        // Always use current props.cloud if capturedCloud is not provided - never use stale lastCapturedCloud
        // This ensures we always have the correct filtered cloud data (upwind or downwind) from Performance.tsx
        const cloudToUse = capturedCloud !== undefined ? capturedCloud : (props.cloud && Array.isArray(props.cloud) ? props.cloud : []);

        let aggregate_data = [];
        let cloud_data = [];
        let target_data = [];

        if (props.filters && props.filters.length > 0) {
            props.filters.forEach((filter: string) => {
                if (filter == 'upwind') {
                    aggregate_data = filterData(aggregatesToUse, "UW", "BOTH");
                    // props.cloud is already filtered by Performance.tsx, so use it directly without re-filtering
                    cloud_data = (cloudToUse && Array.isArray(cloudToUse) && cloudToUse.length > 0) ? cloudToUse : [];
                    target_data = props.targets?.['UPWIND'] || [];
                } else if (filter == 'downwind') {
                    aggregate_data = filterData(aggregatesToUse, "DW", "BOTH");
                    // props.cloud is already filtered by Performance.tsx, so use it directly without re-filtering
                    cloud_data = (cloudToUse && Array.isArray(cloudToUse) && cloudToUse.length > 0) ? cloudToUse : [];
                    target_data = props.targets?.['DOWNWIND'] || [];
                }
            });
        } else {
            // When filters are empty, check uwDw prop for aggregate filtering
            // NOTE: props.cloud is already filtered by Performance.tsx based on UwDw toggle,
            // so we should NOT filter it again here - just use it directly
            if (props.uwDw === 'UPWIND') {
                aggregate_data = filterData(aggregatesToUse, "UW", "BOTH");
                // Use cloud directly - it's already filtered to upwind by Performance.tsx
                cloud_data = (cloudToUse && Array.isArray(cloudToUse) && cloudToUse.length > 0) ? cloudToUse : [];
                target_data = props.targets?.['UPWIND'] || props.targets || [];
            } else if (props.uwDw === 'DOWNWIND') {
                aggregate_data = filterData(aggregatesToUse, "DW", "BOTH");
                // Use cloud directly - it's already filtered to downwind by Performance.tsx
                cloud_data = (cloudToUse && Array.isArray(cloudToUse) && cloudToUse.length > 0) ? cloudToUse : [];
                target_data = props.targets?.['DOWNWIND'] || props.targets || [];
            } else {
                aggregate_data = filterData(aggregatesToUse, "NONE", "BOTH");
                // Use cloud directly - it's already filtered by Performance.tsx
                cloud_data = (cloudToUse && Array.isArray(cloudToUse) && cloudToUse.length > 0) ? cloudToUse : [];
                target_data = props.targets || [];
            }
        }

        // Target data structure: object with field names as keys (often `*.speedUnit_target` from cloud)
        // Use the exact field name from chart configuration (taxis prop) to look up the target data
        // The chart configuration specifies the exact field name in yaxisTarget.dataField or yaxisTarget.name
        let target_data_array: any[] = [];
        if (target_data && typeof target_data === 'object' && !Array.isArray(target_data)) {
            // Target data is an object, use taxis prop directly as the key (it comes from chart configuration)
            const taxisField = props.taxis;
            const availableKeys = Object.keys(target_data);
            
            logDebug('AdvancedScatter: Looking for target data field', {
                taxisField,
                availableKeys,
                targetDataType: typeof target_data,
                isArray: Array.isArray(target_data)
            });
            
            // Try exact match first (chart configuration specifies the exact field name)
            if (target_data[taxisField] && Array.isArray(target_data[taxisField])) {
                target_data_array = target_data[taxisField];
                logDebug('AdvancedScatter: Found target data with exact match', { key: taxisField, count: target_data_array.length });
            } else {
                // Try case-insensitive match (in case of case differences)
                const matchingKey = availableKeys.find(key => key.toLowerCase() === taxisField.toLowerCase());
                if (matchingKey && Array.isArray(target_data[matchingKey])) {
                    target_data_array = target_data[matchingKey];
                    logDebug('AdvancedScatter: Found target data with case-insensitive match', { key: matchingKey, searched: taxisField, count: target_data_array.length });
                } else {
                    logError('AdvancedScatter: Could not find target data field', {
                        taxisField,
                        availableKeys,
                        firstFewKeys: availableKeys.slice(0, 10),
                        firstFewValues: availableKeys.slice(0, 3).map(k => ({ key: k, isArray: Array.isArray(target_data[k]), length: Array.isArray(target_data[k]) ? target_data[k].length : 'N/A' }))
                    });
                }
            }
        } else if (Array.isArray(target_data)) {
            // Target data is already an array
            target_data_array = target_data;
            logDebug('AdvancedScatter: Target data is already an array', { count: target_data_array.length });
        } else {
            logError('AdvancedScatter: Target data is not an object or array', {
                targetDataType: typeof target_data,
                isArray: Array.isArray(target_data),
                value: target_data
            });
        }

        // Use separate aggregate data for x-axis and y-axis if available
        const xType = (props.xType || props.aggregate || 'AVG').toUpperCase();
        const yType = (props.yType || props.aggregate || 'AVG').toUpperCase();
        const aggregatesByType: { [key: string]: any[] } = {
            AVG: props.aggregatesAVG || aggregate_data,
            STD: props.aggregatesSTD || aggregate_data,
            AAV: props.aggregatesAAV || aggregate_data
        };
        const xAggregateData = aggregatesByType[xType] || aggregate_data;
        const yAggregateData = aggregatesByType[yType] || aggregate_data;
        
        // Filter x and y data separately when we have separate aggregate data
        // This is needed even when xType === yType because the x-axis channel might be different
        let xFilteredData = aggregate_data;
        let yFilteredData = aggregate_data;
        if (props.aggregatesAVG || props.aggregatesSTD || props.aggregatesAAV) {
            // Apply same filters to x and y data using their respective aggregate types
            if (props.filters && props.filters.length > 0) {
                props.filters.forEach((filter: string) => {
                    if (filter == 'upwind') {
                        xFilteredData = filterData(xAggregateData, "UW", "BOTH");
                        yFilteredData = filterData(yAggregateData, "UW", "BOTH");
                    } else if (filter == 'downwind') {
                        xFilteredData = filterData(xAggregateData, "DW", "BOTH");
                        yFilteredData = filterData(yAggregateData, "DW", "BOTH");
                    }
                });
            } else {
                if (props.uwDw === 'UPWIND') {
                    xFilteredData = filterData(xAggregateData, "UW", "BOTH");
                    yFilteredData = filterData(yAggregateData, "UW", "BOTH");
                } else if (props.uwDw === 'DOWNWIND') {
                    xFilteredData = filterData(xAggregateData, "DW", "BOTH");
                    yFilteredData = filterData(yAggregateData, "DW", "BOTH");
                } else {
                    xFilteredData = filterData(xAggregateData, "NONE", "BOTH");
                    yFilteredData = filterData(yAggregateData, "NONE", "BOTH");
                }
            }
        }
        
        const aggregate_data_r = reduceData(aggregate_data, props.xaxis, props.yaxis, xFilteredData, yFilteredData);
        // Always reduce cloud_data, even if empty, to ensure we get an empty array (not undefined)
        const cloud_data_r = (cloud_data && Array.isArray(cloud_data) && cloud_data.length > 0) ? reduceData(cloud_data, props.xaxis, props.yaxis) : [];
        // Only process targets if taxis is specified (target explicitly configured in chart)
        let target_data_r: any[] = [];
        if (props.taxis && props.taxis.trim() !== '' && target_data_array.length > 0) {
            target_data_r = reduceTargets(target_data_array, props.xaxis.toLowerCase(), props.taxis);
        } else {
            logDebug('AdvancedScatter [drawDataElementsOnly]: Skipping target processing - no target specified in chart configuration', {
                taxis: props.taxis,
                targetDataArrayLength: target_data_array.length
            });
        }

        if (aggregate_data_r && aggregate_data_r.length > 0) {
            getXBounds([aggregate_data_r], cloud_data_r, aggregate_data_r);
            getYBounds([aggregate_data_r]);
        }

        const containerWidth = chartRef?.clientWidth || 450;
        const containerHeight = chartRef?.clientHeight || 500;
        chartWidth = containerWidth - margin.left - margin.right;
        chartHeight = containerHeight - margin.top - margin.bottom;

        // Check if x-axis is the default (TWA) to ensure we use the calculated bounds
        const twaChannel = twaName().toLowerCase();
        const xaxisLower = props.xaxis ? props.xaxis.toLowerCase() : '';
        const isDefaultXAxis = xaxisLower === twaChannel || xaxisLower === 'twa';
        
        let xDomainMin = xMin;
        let xDomainMax = xMax;
        if (xMin === 9999999 || xMax === -9999999 || xMin > xMax) {
            xDomainMin = 5;
            xDomainMax = 25;
        }
        
        // For default x-axis, ensure we're using the calculated bounds (which include interval padding)
        if (isDefaultXAxis && xMin !== 9999999 && xMax !== -9999999) {
            xDomainMin = xMin;
            xDomainMax = xMax;
        }
        
        xScale = d3.scaleLinear().range([0, chartWidth]).domain([xDomainMin, xDomainMax]);
        yScale = d3.scaleLinear().range([chartHeight, 0]).domain([yMin, yMax]);

        const chartbody = svg.select("g");
        chartbody.selectAll(".scatter").remove();
        chartbody.selectAll(".target-line, .target-path, .tgt, .fit").remove();
        // Always remove cloud first
        chartbody.selectAll(".cloud-area").remove();
        svg.selectAll(".lasso").remove();

        isLassoActive = false;
        listenersAttached = false;

        // Draw cloud area only if we have data
        if (cloud_data_r && cloud_data_r.length > 0) {
            drawArea(cloud_data_r);
        } else {
            // Explicitly ensure cloud is removed
            removeCloudArea();
        }
        // Draw scatter points (middle layer)
        drawScatter(aggregate_data_r);
        // Draw target line last (top layer - after cloud and scatter points) - only if target is specified
        if (target_data_r && target_data_r.length > 0) {
            drawSpline(target_data_r);
        }

        setFiltered(aggregate_data_r);

        if (props.zoom) {
            scheduleDrawFit();
        }

        const selected = selectedEvents();
        if (selected && selected.length > 0) {
            d3.selectAll(".scatter").each(function (d: any) {
                if (selected.includes(d.ID)) {
                    d3.select(this).style('opacity', 1);
                } else {
                    d3.select(this).style('opacity', 0.2);
                }
            });
        }
    }

    // Update colors function with signature-based change detection
    function updateColors(): void {
        if (!chartRef) return;
        const svg = d3.select(chartRef).select("svg");
        if (!svg.node()) return;
        
        const getFillColorLocal = (d: any) => getColor(d);
        const strokeColor = getThemeStrokeColor();

        svg.selectAll("circle.scatter")
            .transition()
            .duration(500)
            .style("fill", (d: any) => getFillColorLocal(d))
            .style("stroke", strokeColor);

        svg.selectAll("rect.scatter")
            .transition()
            .duration(500)
            .style("fill", (d: any) => getFillColorLocal(d))
            .style("stroke", strokeColor);
    }

    // Update point sizes and opacity based on selection
    const updatePointSizesAndOpacity = () => {
        if (!chartRef) return;
        const svg = d3.select(chartRef).select("svg").node();
        if (!svg) return;

        const selected = selectedEvents();
        const hasSelection = selected.length > 0;
        const scatterPoints = d3.select(chartRef).selectAll(".scatter");
        const currentMouseID = typeof props.mouseID === 'function' ? props.mouseID() : (props.mouseID || null);

        if (scatterPoints.size() > 0) {
            scatterPoints.filter("circle")
                .transition()
                .duration(200)
                .attr("r", (d: any) => {
                    if (!d || d.ID === undefined || d.ID === null) return 5;
                    const isSelected = hasSelection && selected.includes(d.ID);
                    const isHovered = currentMouseID && d.ID === currentMouseID;
                    if (isHovered) return 10;
                    return hasSelection ? (isSelected ? 6 : 4) : 5;
                });

            scatterPoints.filter("rect")
                .transition()
                .duration(200)
                .attr("width", (d: any) => {
                    if (!d || d.ID === undefined || d.ID === null) return 8.25;
                    const isSelected = hasSelection && selected.includes(d.ID);
                    const isHovered = currentMouseID && d.ID === currentMouseID;
                    if (isHovered) return 14;
                    return hasSelection ? (isSelected ? 11 : 6) : 8.25;
                })
                .attr("height", (d: any) => {
                    if (!d || d.ID === undefined || d.ID === null) return 8.25;
                    const isSelected = hasSelection && selected.includes(d.ID);
                    const isHovered = currentMouseID && d.ID === currentMouseID;
                    if (isHovered) return 14;
                    return hasSelection ? (isSelected ? 11 : 6) : 8.25;
                });

            scatterPoints.each(function (d: any) {
                if (d.ID === undefined || d.ID === null) return;
                if (selected && selected.length > 0 && selected.includes(d.ID)) {
                    d3.select(this).style('opacity', 1);
                } else if (selected && selected.length > 0) {
                    d3.select(this).style('opacity', 0.2);
                } else {
                    d3.select(this).style('opacity', 1);
                }
            });
        }
    };

    // Effect to watch for initial aggregates data and trigger draw
    let lastAggregatesLength = 0;
    let initialDrawTimer: ReturnType<typeof setTimeout> | null = null;
    createEffect(() => {
        if (isCleaningUp) return; // Don't run during cleanup
        if (!chartRef || !chartRef.isConnected) return;
        
        const aggregatesValue = props.aggregates;
        const cloudValue = props.cloud;
        
        // Check if aggregates changed from empty to having data
        const currentLength = Array.isArray(aggregatesValue) ? aggregatesValue.length : 0;
        const aggregatesChanged = currentLength !== lastAggregatesLength;
        lastAggregatesLength = currentLength;
        
        // Only draw if we have data and (chart doesn't exist or data changed)
        if (aggregatesValue && Array.isArray(aggregatesValue) && aggregatesValue.length > 0) {
            const chartExists = d3.select(chartRef).select("svg").node();
            if (!chartExists || aggregatesChanged) {
                // Clear any pending draw
                if (initialDrawTimer) {
                    clearTimeout(initialDrawTimer);
                }
                
                // Use a small delay to ensure DOM is ready
                initialDrawTimer = setTimeout(() => {
                    // Check cleanup flag and connection before proceeding
                    if (isCleaningUp || !chartRef || !chartRef.isConnected) {
                        initialDrawTimer = null;
                        return;
                    }
                    const isChartVisible = isVisible();
                    const rect = chartRef.getBoundingClientRect();
                    const isInViewport = rect.top < window.innerHeight && rect.bottom > 0;
                    const hasDimensions = rect.width > 0 && rect.height > 0;
                    
                    // Draw if visible, in viewport, or has dimensions (chart container is ready)
                    if (isChartVisible || isInViewport || hasDimensions || !chartExists) {
                        drawChart(aggregatesValue, cloudValue);
                        requestAnimationFrame(() => props.onChartRendered?.());
                    }
                    initialDrawTimer = null;
                }, 100);
            }
        }
    });


    // Unified filter effect with detailed signature matching (fixes duplicate effects issue)
    let filterRedrawTimer: ReturnType<typeof setTimeout> | null = null;
    let lastFilterSignature = '';
    let filterEffectCount = 0;
    let lastUpdateCharts: boolean | undefined = undefined;
    let lastUwDw: string | undefined = undefined;

    createEffect(() => {
        if (isCleaningUp) return; // Don't run during cleanup
        if (!isVisible()) return;
        if (isUpdatingData) return;
        if (!chartRef || !chartRef.isConnected) return;

        filterEffectCount++;
        if (filterEffectCount > 50) {
            logError('🚨 INFINITE LOOP DETECTED in AdvancedScatter filter effect!', filterEffectCount);
            filterEffectCount = 0;
            return;
        }

        // Track all filter signals with detailed signature (from PerfScatter)
        const filterState = {
            states: selectedStatesTimeseries(),
            races: selectedRacesTimeseries(),
            legs: selectedLegsTimeseries(),
            grades: selectedGradesTimeseries()
        };

        const statesStr = filterState.states.sort().join(',');
        const racesStr = filterState.races.sort().join(',');
        const legsStr = filterState.legs.sort().join(',');
        const gradesStr = filterState.grades.sort().join(',');
        const currentFilterSignature = `${statesStr}|${racesStr}|${legsStr}|${gradesStr}`;

        // Also track updateCharts and uwDw changes
        const currentUpdateCharts = props.updateCharts;
        const currentUwDw = props.uwDw;
        const dataChanged = currentUpdateCharts !== lastUpdateCharts || currentUwDw !== lastUwDw || currentFilterSignature !== lastFilterSignature;

        if (!dataChanged) {
            filterEffectCount = 0;
            return;
        }

        lastFilterSignature = currentFilterSignature;
        lastUpdateCharts = currentUpdateCharts;
        lastUwDw = currentUwDw;

        if (filterRedrawTimer) {
            clearTimeout(filterRedrawTimer);
        }

        filterRedrawTimer = setTimeout(() => {
            // Check cleanup flag and connection before proceeding
            if (isCleaningUp || !chartRef || !chartRef.isConnected) {
                filterRedrawTimer = null;
                return;
            }

            const aggregatesValue = untrack(() => props.aggregates);
            const cloudValue = untrack(() => props.cloud);
            const chartNode = untrack(() => d3.select(chartRef).select("svg").node());
            
            requestAnimationFrame(() => {
                // Double-check before executing (component might have been unmounted)
                if (isCleaningUp || !chartRef || !chartRef.isConnected) {
                    filterEffectCount = 0;
                    filterRedrawTimer = null;
                    return;
                }
                if (aggregatesValue && chartNode) {
                    drawChart(aggregatesValue, cloudValue);
                    // Notify parent so mode-switching overlay can be hidden
                    requestAnimationFrame(() => props.onChartRendered?.());
                }
                filterEffectCount = 0;
            });
            
            filterRedrawTimer = null;
        }, 200);
    });

    // Combined zoom/selection/highlights effect with debouncing to prevent lockups
    let zoomFitTimer: ReturnType<typeof setTimeout> | null = null;
    let zoomFitRafId: number | null = null;
    let lastZoomState: boolean | undefined = undefined;
    let lastSelectionSignature = '';
    let lastHighlightsSignature = '';

    function cancelZoomFitWork(): void {
        if (zoomFitTimer != null) {
            clearTimeout(zoomFitTimer);
            zoomFitTimer = null;
        }
        if (zoomFitRafId != null) {
            cancelAnimationFrame(zoomFitRafId);
            zoomFitRafId = null;
        }
    }
    
    createEffect(() => {
        if (isCleaningUp) return; // Don't run effects during cleanup
        if (!isVisible()) return;
        if (!chartRef || !chartRef.isConnected) return;
        if (isUpdatingData) return;
        
        const isZoomed = props.zoom;
        const selection = selectedEvents && typeof selectedEvents === 'function' ? selectedEvents() : [];
        const highlights = props.highlights && Array.isArray(props.highlights) ? props.highlights : [];
        
        // Create signatures to detect actual changes
        const selectionSignature = Array.isArray(selection) ? selection.sort().join(',') : '';
        const highlightsSignature = Array.isArray(highlights) ? highlights.map((h: any) => String(h)).sort().join(',') : '';
        
        // Check if anything actually changed
        const zoomChanged = isZoomed !== lastZoomState;
        const selectionChanged = selectionSignature !== lastSelectionSignature;
        const highlightsChanged = highlightsSignature !== lastHighlightsSignature;
        
        if (!zoomChanged && !selectionChanged && !highlightsChanged) {
            return; // No changes, skip
        }
        
        lastZoomState = isZoomed;
        lastSelectionSignature = selectionSignature;
        lastHighlightsSignature = highlightsSignature;
        
        // Abort any pending zoom fit work so we don't run after exit or during cleanup
        cancelZoomFitWork();
        
        if (isZoomed && filtered().length > 0) {
            // Debounce the expensive drawFit operation
            zoomFitTimer = setTimeout(() => {
                if (isCleaningUp || !chartRef || !chartRef.isConnected) {
                    zoomFitTimer = null;
                    return;
                }
                zoomFitRafId = requestAnimationFrame(() => {
                    zoomFitRafId = null;
                    if (isCleaningUp || !chartRef || !chartRef.isConnected) {
                        zoomFitTimer = null;
                        return;
                    }
                    if (props.zoom && filtered().length > 0) {
                        drawFit();
                    }
                    zoomFitTimer = null;
                });
            }, 100); // Small debounce to batch rapid changes
        } else if (!isZoomed) {
            // Clear fit lines when zooming out
            if (!isCleaningUp && chartRef && chartRef.isConnected) {
                const chart = d3.select(chartRef).select("svg").select("g");
                if (chart.node()) {
                    chart.selectAll(".fit").remove();
                }
            }
        }
    });

    // Unified color/groups/colorScale effect with signature-based change detection
    let lastColorGroupsSignature = '';
    let colorGroupsEffectCount = 0;

    createEffect(() => {
        if (!chartRef || !chartRef.isConnected) return;
        if (!isVisible()) return;

        colorGroupsEffectCount++;
        if (colorGroupsEffectCount > 50) {
            logError('🚨 INFINITE LOOP DETECTED in AdvancedScatter color/groups effect!', colorGroupsEffectCount);
            colorGroupsEffectCount = 0;
            return;
        }

        if (props.color && props.groups && props.aggregates) {
            const groupsSignature = props.groups.map((g: any) => `${g.name}:${g.color}`).join('|');
            const aggregatesLength = Array.isArray(props.aggregates) ? props.aggregates.length : 0;
            const colorScaleExists = props.colorScale && typeof props.colorScale === 'function' ? '1' : '0';
            const currentSignature = `${props.color}|${groupsSignature}|${aggregatesLength}|${colorScaleExists}`;

            if (currentSignature === lastColorGroupsSignature) {
                colorGroupsEffectCount = 0;
                return;
            }

            lastColorGroupsSignature = currentSignature;
            const chartExists = d3.select(chartRef).select("svg").node();
            if (chartExists) {
                updateColors();
            } else if (isVisible()) {
                drawChart();
            }
            colorGroupsEffectCount = 0;
        }
    });

    // Color scale availability effect - watch for colorScale changes (e.g., when sources become ready)
    createEffect(() => {
        if (!chartRef || !chartRef.isConnected) return;
        if (!isVisible()) return;
        
        const scale = props.colorScale;
        const color = props.color;
        
        // If we're coloring by SOURCE_NAME and colorScale becomes available, update colors
        if (color === 'SOURCE_NAME' && scale && typeof scale === 'function') {
            const chartExists = d3.select(chartRef).select("svg").node();
            if (chartExists) {
                // Use requestAnimationFrame to ensure DOM is ready
                requestAnimationFrame(() => {
                    updateColors();
                });
            }
        }
    });

    // X-axis change effect
    createEffect(() => {
        if (!chartRef || !chartRef.isConnected) return;
        if (!isVisible()) return;
        
        const currentXAxis = props.xaxis;
        if (currentXAxis && props.aggregates) {
            const chartExists = d3.select(chartRef).select("svg").node();
            if (chartExists) {
                d3.select(chartRef).selectAll("*").remove();
                drawChart();
            }
        }
    });

    // Theme change effect - update stroke colors when theme changes
    createEffect(() => {
        if (!chartRef || !chartRef.isConnected) return;
        if (!isVisible()) return;
        
        // Track theme changes to trigger effect
        void theme();
        
        // Update stroke colors when theme changes - use updateColors to ensure consistency
        const svg = d3.select(chartRef).select("svg");
        if (svg.node()) {
            updateColors();
        }
    });

    // Selection update effects (debounced)
    let triggerSelectionTimer: ReturnType<typeof setTimeout> | null = null;
    createEffect(() => {
        if (!chartRef || !chartRef.isConnected) return;
        if (!isVisible()) return;
        
        if (triggerSelection()) {
            if (triggerSelectionTimer) {
                clearTimeout(triggerSelectionTimer);
            }
            triggerSelectionTimer = setTimeout(() => {
                if (!chartRef) return;
                const chartExists = d3.select(chartRef).select("svg").node();
                if (chartExists) {
                    updatePointSizesAndOpacity();
                }
                triggerSelectionTimer = null;
            }, 50);
        }
    });

    let selectionUpdateTimer: ReturnType<typeof setTimeout> | null = null;
    createEffect(() => {
        if (!chartRef || !chartRef.isConnected) return;
        if (!isVisible()) return;
        
        selectedEvents();
        if (selectionUpdateTimer) {
            clearTimeout(selectionUpdateTimer);
        }
        selectionUpdateTimer = setTimeout(() => {
            if (!chartRef) return;
            const chartExists = d3.select(chartRef).select("svg").node();
            if (chartExists) {
                // Update point sizes/opacity for selection changes, but don't touch cloud
                updatePointSizesAndOpacity();
            }
            selectionUpdateTimer = null;
        }, 50);
    });
    
    // Separate effect for mouseID changes (hover) - only updates point sizes, never touches cloud
    createEffect(() => {
        if (!chartRef || !chartRef.isConnected) return;
        if (!isVisible()) return;
        
        // Access mouseID to track hover changes, but only update point sizes
        // This effect should NOT trigger any cloud redraws
        const currentMouseID = typeof props.mouseID === 'function' ? props.mouseID() : (props.mouseID || null);
        const chartExists = d3.select(chartRef).select("svg").node();
        if (chartExists) {
            // Only update point sizes for hover - never touch cloud
            updatePointSizesAndOpacity();
        }
    });

    // Visibility effect
    createEffect(() => {
        const currentVisibility = isVisible();
        const visibilityChanged = currentVisibility !== lastVisibilityState;
        lastVisibilityState = currentVisibility;
        
        if (currentVisibility && chartRef) {
            requestAnimationFrame(() => {
                if (!chartRef) return;
                const chartExists = d3.select(chartRef).select("svg").node();
                if (chartExists) {
                    // Only check cloud state when visibility actually changes - this prevents cloud from disappearing on hover
                    // Don't call updatePointSizesAndOpacity here - it reads props.mouseID which would make this effect
                    // re-run on every hover, causing unnecessary cloud checks
                    if (!visibilityChanged) {
                        return; // Don't check cloud on every effect run, only when visibility changes
                    }
                    
                    const now = Date.now();
                    const timeSinceLastCheck = now - lastVisibilityEffectTime;
                    if (timeSinceLastCheck < VISIBILITY_EFFECT_THROTTLE_MS) {
                        return; // Throttle even visibility changes
                    }
                    lastVisibilityEffectTime = now;
                    
                    // Only check cloud state if cloud data should exist
                    const shouldHaveCloud = props.cloud && Array.isArray(props.cloud) && props.cloud.length > 0;
                    if (shouldHaveCloud) {
                        // More robust cloud check - look in multiple locations
                        const svg = d3.select(chartRef).select("svg");
                        const chartbody = svg.select("g");
                        const hasCloudInSvg = svg.selectAll(".cloud-area").size() > 0;
                        const hasCloudInBody = chartbody.selectAll(".cloud-area").size() > 0;
                        const hasCloud = hasCloudInSvg || hasCloudInBody;
                        
                            if (!hasCloud) {
                                // Cloud state is incorrect - redraw data elements to fix it
                                // Use current props.cloud (already filtered) instead of lastCapturedCloud to ensure correct filtering
                                drawDataElementsOnly(lastCapturedAggregates, props.cloud);
                            }
                    } else {
                        // Cloud should not exist - ensure it's removed immediately
                        const svg = d3.select(chartRef).select("svg");
                        const chartbody = svg.select("g");
                        const hasCloudInSvg = svg.selectAll(".cloud-area").size() > 0;
                        const hasCloudInBody = chartbody.selectAll(".cloud-area").size() > 0;
                        const hasCloud = hasCloudInSvg || hasCloudInBody;
                        
                        if (hasCloud) {
                            // Remove cloud synchronously
                            if (svg.node()) {
                                svg.selectAll(".cloud-area").remove();
                                svg.selectAll("g.cloud-area").remove();
                                if (chartbody.node()) {
                                    chartbody.selectAll(".cloud-area").remove();
                                    chartbody.selectAll("g.cloud-area").remove();
                                }
                            }
                            removeCloudArea();
                            // If chart has scatter points, redraw to ensure clean state
                            const hasScatterPoints = d3.select(chartRef).selectAll(".scatter").size() > 0;
                            if (hasScatterPoints) {
                                drawDataElementsOnly(lastCapturedAggregates, props.cloud);
                            }
                        }
                    }
                }
            });
        }
    });

    // Grade update function
    const performGradeUpdate = async (gradeValue: number, selected: number[]): Promise<void> => {
        try {
            const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId } = persistantStore;
            const className = selectedClassName();
            const projectId = selectedProjectId();
            const datasetId = selectedDatasetId();
            const sourceId = selectedSourceId();

            if (!className || !projectId) {
                logError('Cannot update GRADE: missing class_name or project_id');
                return;
            }

            const response = await putData(`${apiEndpoints.admin.events}/tags`, {
                class_name: className,
                project_id: projectId,
                events: selected,
                event_types: ['BIN 10'],
                key: 'GRADE',
                value: gradeValue
            });

            if (response.success) {
                logDebug(`Successfully updated GRADE to ${gradeValue} for ${selected.length} event(s)`);

                // Update aggregates in HuniDB with new grade value
                try {
                    await huniDBStore.updateAggregatesMetadata(className, selected, { grade: gradeValue });
                    logDebug(`Successfully updated aggregates grade for ${selected.length} event(s) in HuniDB`);
                } catch (err) {
                    logError('Error updating aggregates grade in HuniDB:', err);
                }

                // Clear events cache to force refetch with updated tags
                if (datasetId) {
                    const datasetIdStr = typeof datasetId === 'function' ? String(datasetId()) : String(datasetId);
                    const cacheKey = `events_${className}_${projectId}_${datasetIdStr}`;
                    unifiedDataStore.clearCacheForDataSource(cacheKey);
                    // Clear all events from cache and local state
                    unifiedDataStore.clearEvents().catch(err => {
                        logError('Error clearing events cache:', err);
                    });
                }

                if (props.onDataUpdate && typeof props.onDataUpdate === 'function') {
                    props.onDataUpdate();
                } else {
                    drawChart();
                }

                // Clear selection and selection banner after grade is posted (same as when grading maneuvers)
                clearSelection();
            } else {
                const data = response.data as { updated?: number; total?: number } | string | unknown[] | undefined;
                const msgFromData =
                    data != null && typeof data === 'object' && !Array.isArray(data) && typeof (data as { updated?: number }).updated === 'number' && typeof (data as { total?: number }).total === 'number'
                        ? `Partially updated: ${(data as { updated: number }).updated} of ${(data as { total: number }).total} events`
                        : typeof data === 'string'
                          ? data
                          : Array.isArray(data) && data.length > 0
                            ? (typeof data[0] === 'string' ? data[0] : JSON.stringify(data[0]))
                            : undefined;
                const errMsg = response.message ?? (response as { error?: string }).error ?? msgFromData;
                const hasStatus = response.status != null && response.status !== undefined;
                const errorMsg =
                    errMsg ||
                    (hasStatus
                        ? `HTTP ${response.status}: ${(response as { statusText?: string }).statusText || 'Unknown error'}`
                        : 'Network or server error (no details returned). Check that the admin server is reachable and try again.');
                logError(`Failed to update GRADE: ${errorMsg}`, {
                    status: response.status,
                    message: response.message,
                    error: (response as { error?: string }).error,
                    data: response.data,
                    url: `${apiEndpoints.admin.events}/tags`,
                    eventIds: selected,
                    ...(!errMsg && !hasStatus ? { fullResponse: response } : {})
                });
                // Show user-visible error
                alert(`Failed to update GRADE: ${errorMsg}\n\nPlease check the console for more details.`);
            }
        } catch (error: any) {
            logError('Error updating GRADE:', error);
            // Show user-visible error
            const errorMsg = error instanceof Error ? error.message : String(error);
            alert(`Error updating GRADE: ${errorMsg}\n\nPlease check the console for more details.`);
        }
    };

    const performStateUpdate = async (stateValue: string, selected: number[]): Promise<void> => {
        try {
            const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId } = persistantStore;
            const className = selectedClassName();
            const projectId = selectedProjectId();
            const datasetId = selectedDatasetId();

            if (!className || !projectId) {
                logError('Cannot update STATE: missing class_name or project_id');
                return;
            }

            const response = await putData(`${apiEndpoints.admin.events}/tags`, {
                class_name: className,
                project_id: projectId,
                events: selected,
                event_types: ['BIN 10'],
                key: 'FOILING_STATE',
                value: stateValue
            });

            if (response.success) {
                logDebug(`Successfully updated STATE to ${stateValue} for ${selected.length} event(s)`);

                // Update aggregates in HuniDB with new state value
                try {
                    await huniDBStore.updateAggregatesMetadata(className, selected, { state: stateValue });
                    logDebug(`Successfully updated aggregates state for ${selected.length} event(s) in HuniDB`);
                } catch (err) {
                    logError('Error updating aggregates state in HuniDB:', err);
                }

                // Clear events cache to force refetch with updated tags
                if (datasetId) {
                    const datasetIdStr = typeof datasetId === 'function' ? String(datasetId()) : String(datasetId);
                    const cacheKey = `events_${className}_${projectId}_${datasetIdStr}`;
                    unifiedDataStore.clearCacheForDataSource(cacheKey);
                    // Clear all events from cache and local state
                    unifiedDataStore.clearEvents().catch(err => {
                        logError('Error clearing events cache:', err);
                    });
                }

                if (props.onDataUpdate && typeof props.onDataUpdate === 'function') {
                    props.onDataUpdate();
                } else {
                    drawChart();
                }

                // Clear selection and selection banner after state is posted (same as when grading maneuvers)
                clearSelection();
            } else {
                const data = response.data as { updated?: number; total?: number } | string | unknown[] | undefined;
                const msgFromData =
                    data != null && typeof data === 'object' && !Array.isArray(data) && typeof (data as { updated?: number }).updated === 'number' && typeof (data as { total?: number }).total === 'number'
                        ? `Partially updated: ${(data as { updated: number }).updated} of ${(data as { total: number }).total} events`
                        : typeof data === 'string'
                          ? data
                          : Array.isArray(data) && data.length > 0
                            ? (typeof data[0] === 'string' ? data[0] : JSON.stringify(data[0]))
                            : undefined;
                const errMsg = response.message ?? (response as { error?: string }).error ?? msgFromData;
                const hasStatus = response.status != null && response.status !== undefined;
                const errorMsg =
                    errMsg ||
                    (hasStatus
                        ? `HTTP ${response.status}: ${(response as { statusText?: string }).statusText || 'Unknown error'}`
                        : 'Network or server error (no details returned). Check that the admin server is reachable and try again.');
                logError(`Failed to update STATE: ${errorMsg}`, {
                    status: response.status,
                    message: response.message,
                    error: (response as { error?: string }).error,
                    data: response.data,
                    url: `${apiEndpoints.admin.events}/tags`,
                    eventIds: selected,
                    ...(!errMsg && !hasStatus ? { fullResponse: response } : {})
                });
                // Show user-visible error
                alert(`Failed to update STATE: ${errorMsg}\n\nPlease check the console for more details.`);
            }
        } catch (error: any) {
            logError('Error updating STATE:', error);
            // Show user-visible error
            const errorMsg = error instanceof Error ? error.message : String(error);
            alert(`Error updating STATE: ${errorMsg}\n\nPlease check the console for more details.`);
        }
    };

    // Lifecycle hooks
    onMount(() => {
        const capturedAggregates = props.aggregates;
        const capturedCloud = props.cloud;
        lastCapturedAggregates = capturedAggregates;
        lastCapturedCloud = capturedCloud;
        
        if (chartRef) {
            intersectionObserver = new IntersectionObserver(
                (entries) => {
                    entries.forEach(entry => {
                        const wasVisible = isVisible();
                        setIsVisible(entry.isIntersecting);
                        
                        // Manual viewport check to verify actual visibility
                        const rect = chartRef?.getBoundingClientRect();
                        const isActuallyVisible = rect && rect.top < window.innerHeight && rect.bottom > 0 && rect.width > 0 && rect.height > 0;
                        
                        if (entry.isIntersecting && !wasVisible) {
                            const hasSVG = chartRef && d3.select(chartRef).select("svg").node();
                            if (hasSVG && storedMouseover && storedMouseout && storedClick) {
                                const scatterPoints = d3.select(chartRef).selectAll(".scatter");
                                if (scatterPoints.size() > 0 && !listenersAttached) {
                                    scatterPoints
                                        .on("mouseover", storedMouseover)
                                        .on("mouseout", storedMouseout)
                                        .on("click", storedClick);
                                    listenersAttached = true;
                                }
                            }
                        } else if (!entry.isIntersecting && wasVisible) {
                            // Only remove elements if chart is actually not visible (double-check with manual viewport check)
                            if (!isActuallyVisible) {
                                const scatterPoints = d3.select(chartRef).selectAll(".scatter");
                                scatterPoints
                                    .on("mouseover", null)
                                    .on("mouseout", null)
                                    .on("click", null)
                                    .remove();
                                d3.select(chartRef).selectAll(".target-line, .target-path, .tgt, .fit").remove();
                                d3.select(chartRef).selectAll(".cloud-area").remove();
                                d3.select(chartRef).selectAll(".lasso").remove();
                                listenersAttached = false;
                            }
                        }
                        
                        if (entry.isIntersecting || isActuallyVisible) {
                            const hasSVG = d3.select(chartRef).select("svg").node();
                            if (!hasSVG) {
                                // Use current props instead of captured values to ensure we have latest data
                                drawChart(props.aggregates, props.cloud);
                            } else {
                                // Only check cloud state when visibility actually changes, or throttle frequent checks
                                const now = Date.now();
                                const visibilityChanged = entry.isIntersecting !== wasVisible;
                                const shouldCheckCloud = visibilityChanged || (now - lastCloudCheckTime > CLOUD_CHECK_THROTTLE_MS);
                                
                                if (shouldCheckCloud) {
                                    lastCloudCheckTime = now;
                                    // Use current props instead of captured values to ensure we have latest data
                                    const currentAggregates = props.aggregates;
                                    const currentCloud = props.cloud;
                                    const hasDataElements = d3.select(chartRef).selectAll(".scatter").size() > 0;
                                    const hasCloud = d3.select(chartRef).selectAll(".cloud-area").size() > 0;
                                    const shouldHaveCloud = currentCloud && Array.isArray(currentCloud) && currentCloud.length > 0;
                                    
                                    // Only check cloud state if cloud data should exist
                                    if (!hasDataElements) {
                                        drawDataElementsOnly(currentAggregates, currentCloud);
                                    } else if (shouldHaveCloud) {
                                        // Only check cloud state if we expect cloud to be present
                                        if (!hasCloud) {
                                            drawDataElementsOnly(currentAggregates, currentCloud);
                                        }
                                    } else if (hasCloud) {
                                        // Cloud exists but shouldn't - remove it without full redraw
                                        d3.select(chartRef).selectAll(".cloud-area").remove();
                                    }
                                }
                            }
                        }
                    });
                },
                {
                    // Buffer: 500px top (preload before visible) and 500px bottom (keep loaded after leaving viewport)
                    // This ensures charts are populated before scrolling into view and stay populated while still visible
                    rootMargin: '500px 0px 500px 0px',
                    threshold: 0.01
                }
            );
            intersectionObserver.observe(chartRef);
            
            setTimeout(() => {
                if (isVisible() && !d3.select(chartRef).select("svg").node()) {
                    drawChart(props.aggregates, props.cloud);
                }
            }, 0);
        } else {
            drawChart(props.aggregates, props.cloud);
        }

        let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
        const handleResize = () => {
            if (!isVisible()) return;
            if (resizeTimeout) {
                clearTimeout(resizeTimeout);
            }
            resizeTimeout = setTimeout(() => {
                drawChart(lastCapturedAggregates, lastCapturedCloud);
            }, 150);
        };

        window.addEventListener('resize', handleResize);

        const handleKeyPress = async (event: KeyboardEvent) => {
            try {
                if (isUpdatingGrade()) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }

                const now = Date.now();
                if (now - lastGradeUpdateTime < 1000) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }

                const target = event.target as HTMLElement | null;
                if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                    return;
                }

                // Only handle grade/state hotkeys when this chart is visible (e.g. Performance tab active).
                // When the maneuver page/tab is active, let maneuver Map/TimeSeries handle the key.
                if (!isVisible()) return;

                const selected = selectedEvents();
                const key = event.key;
                const colorType = props.color;

                // Only handle hotkeys when colored by STATE or GRADE
                if (colorType !== 'STATE' && colorType !== 'GRADE') {
                    return;
                }

                const currentUser = user();
                if (!currentUser) return;

                // Superusers can always grade
                if (!currentUser.is_super_user) {
                    // Check if user is a reader - readers cannot grade
                    const userPermissions = currentUser.permissions;
                    let isReader = false;
                    
                    if (typeof userPermissions === 'string') {
                        isReader = userPermissions === 'reader';
                    } else if (typeof userPermissions === 'object' && userPermissions !== null) {
                        const permissionValues = Object.values(userPermissions);
                        // User is a reader if ALL their permissions are 'reader'
                        isReader = permissionValues.length > 0 && permissionValues.every(p => p === 'reader');
                    }
                    
                    if (isReader) {
                        return; // Readers cannot grade
                    }
                }

                // Handle STATE update hotkeys (0, 1, 2) when colored by STATE
                if (colorType === 'STATE' && selected && selected.length > 0 && ['0', '1', '2'].includes(key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();

                    lastGradeUpdateTime = now;
                    setIsUpdatingGrade(true);

                    // Map keys to state values
                    const stateMap: Record<string, string> = { '0': 'H0', '1': 'H1', '2': 'H2' };
                    const stateValue = stateMap[key];

                    const message = `Are you sure you want to update STATE to ${stateValue} for ${selected.length} selected event(s)?\n\nThis action will modify the data and cannot be easily undone.`;
                    const confirmed = window.confirm(message);
                    if (!confirmed) {
                        setIsUpdatingGrade(false);
                        return;
                    }

                    setTimeout(() => {
                        performStateUpdate(stateValue, selected)
                            .catch(error => {
                                logError('Error in performStateUpdate:', error);
                            })
                            .finally(() => {
                                setIsUpdatingGrade(false);
                            });
                    }, 0);
                    return;
                }

                // Handle GRADE update hotkeys (0, 1, 2, 3) when colored by GRADE
                if (colorType === 'GRADE' && selected && selected.length > 0 && ['0', '1', '2', '3'].includes(key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();

                    lastGradeUpdateTime = now;
                    setIsUpdatingGrade(true);

                    const gradeValue = parseInt(key, 10);
                    const message = `Are you sure you want to update GRADE to ${gradeValue} for ${selected.length} selected event(s)?\n\nThis action will modify the data and cannot be easily undone.`;
                    const confirmed = window.confirm(message);
                    if (!confirmed) {
                        setIsUpdatingGrade(false);
                        return;
                    }

                    setTimeout(() => {
                        performGradeUpdate(gradeValue, selected)
                            .catch(error => {
                                logError('Error in performGradeUpdate:', error);
                            })
                            .finally(() => {
                                setIsUpdatingGrade(false);
                            });
                    }, 0);
                    return;
                }
            } catch (error: any) {
                logError('Error in handleKeyPress:', error);
                event.preventDefault();
                event.stopPropagation();
                setIsUpdatingGrade(false);
            }
        };

        window.addEventListener('keydown', handleKeyPress);

        return () => {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('keydown', handleKeyPress);
            if (resizeTimeout) {
                clearTimeout(resizeTimeout);
            }
        };
    });

    onCleanup(() => {
        // Set cleanup flag immediately to prevent any pending operations
        isCleaningUp = true;
        
        if (intersectionObserver && chartRef) {
            intersectionObserver.unobserve(chartRef);
            intersectionObserver.disconnect();
            intersectionObserver = null;
        }
        
        if (filterRedrawTimer) {
            clearTimeout(filterRedrawTimer);
            filterRedrawTimer = null;
        }
        if (initialDrawTimer) {
            clearTimeout(initialDrawTimer);
            initialDrawTimer = null;
        }
        cancelZoomFitWork();
        if (pendingFitTimerId != null) {
            clearTimeout(pendingFitTimerId);
            pendingFitTimerId = null;
        }
        if (triggerSelectionTimer) {
            clearTimeout(triggerSelectionTimer);
            triggerSelectionTimer = null;
        }
        if (selectionUpdateTimer) {
            clearTimeout(selectionUpdateTimer);
            selectionUpdateTimer = null;
        }
        
        if (lassoWorker) {
            lassoWorker.terminate();
            lassoWorker = null;
        }
        
        d3.select(chartRef).selectAll("*").remove();
        isLassoActive = false;
        isComputingSelection = false;
        setIsComputingLassoSelection(false);
    });

    const infoType = () => props.infoType ?? "";
    const infoMessage = () => (props.infoMessage ?? "").trim();
    const showInfoIcon = () => infoType() === "info" && infoMessage().length > 0;
    const showWarningIcon = () => infoType() === "warning" && infoMessage().length > 0;
    const showInfoOrWarning = () => showInfoIcon() || showWarningIcon();

    const INFO_TOOLTIP_OFFSET = 15;
    const INFO_TOOLTIP_MAX_WIDTH = 280; // match .advanced-scatter-info-tooltip max-width in CSS
    const INFO_TOOLTIP_SHIFT_LEFT = INFO_TOOLTIP_MAX_WIDTH / 2; // translate half the width when near edge

    const getInfoTooltipPosition = (e: MouseEvent) => {
        try {
            if (!containerRef) {
                const x = e.clientX + INFO_TOOLTIP_OFFSET;
                const y = e.clientY + INFO_TOOLTIP_OFFSET;
                const shiftLeft = x + INFO_TOOLTIP_MAX_WIDTH > window.innerWidth;
                return {
                    x: shiftLeft ? e.clientX - INFO_TOOLTIP_SHIFT_LEFT - INFO_TOOLTIP_OFFSET : x,
                    y,
                };
            }
            const rect = containerRef.getBoundingClientRect();
            const scrollX = containerRef.scrollLeft ?? 0;
            const scrollY = containerRef.scrollTop ?? 0;
            const relX = e.clientX - rect.left + scrollX;
            const relY = e.clientY - rect.top + scrollY;
            const xDefault = relX + INFO_TOOLTIP_OFFSET;
            const rightEdge = scrollX + rect.width;
            const shiftLeft = xDefault + INFO_TOOLTIP_MAX_WIDTH > rightEdge;
            const x = shiftLeft ? relX - INFO_TOOLTIP_SHIFT_LEFT - INFO_TOOLTIP_OFFSET : xDefault;
            return { x, y: relY + INFO_TOOLTIP_OFFSET };
        } catch {
            return { x: e.clientX + INFO_TOOLTIP_OFFSET, y: e.clientY + INFO_TOOLTIP_OFFSET };
        }
    };

    const onInfoIconMouseEnter = (e: MouseEvent) => {
        const msg = infoMessage();
        if (msg.length === 0) return;
        const position = getInfoTooltipPosition(e);
        const escaped = msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        setTooltip({
            visible: true,
            content: `<span class="advanced-scatter-info-tooltip">${escaped}</span>`,
            x: position.x,
            y: position.y,
        });
    };
    const onInfoIconMouseMove = (e: MouseEvent) => {
        if (infoMessage().length === 0) return;
        const position = getInfoTooltipPosition(e);
        setTooltip((prev) => (prev.visible ? { ...prev, x: position.x, y: position.y } : prev));
    };
    const onInfoIconMouseLeave = () => {
        setTooltip({ visible: false, content: "", x: 0, y: 0 });
    };

    return (
        <div style={{ width: "100%", height: "100%", display: "flex", position: "relative" }}>
            <div
                ref={(el) => { chartRef = el as HTMLDivElement }}
                class={`advanced-scatter-chart-container ${props.zoom ? 'advanced-scatter-chart-container-zoomed' : 'advanced-scatter-chart-container-normal'}`}
                style={{ width: "100%", height: "100%", minHeight: "500px" }}
            ></div>
            <Show when={showInfoOrWarning()}>
                <div
                    class="advanced-scatter-info-icon-wrap"
                    role="img"
                    aria-label={infoType() === "warning" ? "Warning" : "Info"}
                    onMouseEnter={onInfoIconMouseEnter}
                    onMouseMove={onInfoIconMouseMove}
                    onMouseLeave={onInfoIconMouseLeave}
                >
                    <Show when={showInfoIcon()}>
                        <img
                            src={infoIconUrl}
                            alt="Info"
                            class="advanced-scatter-info-icon"
                            classList={{ "advanced-scatter-info-icon-dark": isDark() }}
                        />
                    </Show>
                    <Show when={showWarningIcon()}>
                        <img
                            src={warningIconUrl}
                            alt="Warning"
                            class="advanced-scatter-info-icon"
                        />
                    </Show>
                </div>
            </Show>
            <Show when={isComputingLassoSelection()}>
                <div style={{
                    position: "absolute",
                    top: "10px",
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: "rgba(0, 0, 0, 0.7)",
                    color: "white",
                    padding: "8px 16px",
                    "border-radius": "4px",
                    "font-size": "14px",
                    "z-index": 1000,
                    "pointer-events": "none"
                }}>
                    Computing selection...
                </div>
            </Show>
            <Show when={props.zoom && fitData().length > 0}>
                <div class="advanced-scatter-table-container">
                    <Table
                        xaxis={props.xaxis}
                        fitData={fitData()}
                        version={fitDataVersion()}
                        loessFactor={loessBandwidth()}
                        onLoessFactorChange={(delta: number) => {
                            setLoessBandwidth((v) => Math.max(0.1, Math.min(1, v + delta)));
                            drawFit();
                        }}
                    />
                </div>
            </Show>
            <div style={{ clear: "both" }}></div>
        </div>
    );
}

