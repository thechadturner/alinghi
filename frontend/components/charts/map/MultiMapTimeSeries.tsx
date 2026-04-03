// @ts-nocheck
import { createSignal, createMemo, createEffect, onMount, onCleanup } from "solid-js";
import * as d3 from "d3";
import { sourcesStore } from "../../../store/sourcesStore";
import { selectedTime, isPlaying, setSelectedTime, setIsManualTimeChange, isManualTimeChange, requestTimeControl, releaseTimeControl, timeWindow } from "../../../store/playbackStore";
import { unifiedDataStore } from "../../../store/unifiedDataStore";
import { persistantStore } from "../../../store/persistantStore";
import { selectedRange, setSelectedRange, setHasSelection, setIsCut, cutEvents, setSelectedRanges,  setSelectedEvents } from "../../../store/selectionStore";
import { selectedRacesTimeseries as globalSelectedRaces, selectedLegsTimeseries as globalSelectedLegs, raceOptions } from "../../../store/filterStore";
import { debug, warn as logWarn, error as logError } from "../../../utils/console";
import { getData } from "../../../utils/global";
import { themeStore } from "../../../store/themeStore";
import { defaultChannelsStore } from "../../../store/defaultChannelsStore";
import {
  mapTimelineChannelValue,
  mapTimelineYAxisLabelParts,
  speedUnitSuffix,
} from "../../../utils/speedUnits";
import { formatTime } from "../../../utils/global";
import { getCurrentDatasetTimezone } from "../../../store/datasetTimezoneStore";

interface MultiMapTimeSeriesProps {
  samplingFrequency?: number;
  onStableSelectedTimeChange?: (time: Date) => void;
  onMapUpdate?: () => void;
  /** Set of enabled source IDs, or accessor so effects/memos re-run when selection changes (e.g. from Map Settings) */
  selectedSourceIds?: Set<number> | (() => Set<number>);
  /** Source IDs to highlight (hovered + selected boats from FleetMap); paths dim when non-empty */
  highlightedSourceIds?: Set<number>;
  /** When true, only show timeline within video (media) windows; requires media fetch for selected sources */
  videoOnly?: boolean;
  /** When false, do not show brush/range UI (only playhead and click-to-seek). Default true. */
  brushEnabled?: boolean;
  /** Called when timeline loading state changes (e.g. for parent to show a waiting overlay). */
  onLoadingChange?: (loading: boolean) => void;
  [key: string]: any;
}

/**
 * MultiMapTimeSeries is used in two isolated contexts:
 * - Map context (FleetMap/MapContainer): videoOnly false/undefined, onMapUpdate drives map track data.
 *   Brush and selection updates affect the map; data is sent via onMapUpdate.
 * - Video context (FleetVideo): videoOnly true, brushEnabled false, onMapUpdate no-op.
 *   Timeline-only; no map to update. We never call onMapUpdate when videoOnly is true so FleetMap is never affected.
 */

interface Dimensions {
  width: number;
  height: number;
}

export default function MultiMapTimeSeries(props: MultiMapTimeSeriesProps) {
  // Don't destructure props to maintain reactivity!
  const { onStableSelectedTimeChange, onMapUpdate } = props;

  /** When true, this instance is timeline-only (e.g. FleetVideo). Never send data to a map. */
  const isVideoContext = (): boolean => !!props.videoOnly;
  /** Only invoke onMapUpdate when used in map context; keeps FleetMap isolated from FleetVideo usage. */
  const safeOnMapUpdate = (data: any[]): void => {
    if (!isVideoContext() && typeof onMapUpdate === 'function') onMapUpdate(data);
  };

  debug('🕐 MultiMapTimeSeries: Component initialized');
  
  let chartContainer: HTMLElement | null = null;
  let svg: any = null;
  let xScale: any = null;
  let yScale: any = null;
  let brush: any = null;
  let brushGroup: any = null;
  let playheadGroup: any = null;

  // Brush state management
  let isBrushActive = false;
  let isClearingBrush = false;
  let isProgrammaticallyUpdatingBrush = false;
  let brushTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastFilterSignature = ''; // Track filter changes to only reset time when filters actually change
  let lastMapUpdateSignature: string | null = null; // Track map update signatures to prevent duplicate updates
  let prevSelectedTime: Date | null = null; // Track previous selected time to detect large jumps
  
  const [dimensions, setDimensions] = createSignal<Dimensions>({ width: 0, height: 0 });
  const [combinedData, setCombinedData] = createSignal<any[]>([]);
  const [mediaWindows, setMediaWindows] = createSignal<any[]>([]);
  const margin = { top: 10, right: 10, bottom: 30, left: 50 };

  // Get timezone for axis formatting
  const getTimezone = () => {
    const tz = getCurrentDatasetTimezone();
    // Always log (removed throttle for debugging)
    debug('🕐 MultiMapTimeSeries.getTimezone: Called', {
      timezone: tz,
      timezoneType: typeof tz,
      isNull: tz === null,
      isUndefined: tz === undefined,
      timestamp: new Date().toISOString(),
      stackTrace: new Error().stack?.split('\n').slice(1, 4).join('\n')
    });
    return tz;
  };

  const sourceKey = (d: any): number | undefined => d?.source_id;

  /** Resolve selectedSourceIds from prop (accessor or value) so effects/memos track and re-run when Map Settings change selection. */
  const getSelectedSourceIds = (): Set<number> => {
    const raw = props.selectedSourceIds;
    if (typeof raw === 'function') return raw() || new Set();
    return raw || new Set();
  };

  // Get dynamic channel names from store
  const { bspName, twsName, vmgName, vmgPercName } = defaultChannelsStore;

  // Helper function to get channel name based on maptype (similar to MapTimeSeries)
  const getChannelName = (): string => {
    const maptype = props.maptype;
    const su = speedUnitSuffix(persistantStore.defaultUnits());
    const tws = twsName() || `Tws_${su}`;
    const bsp = bspName() || `Bsp_${su}`;
    const vmgPerc = vmgPercName() || 'Vmg_perc';
    const vmg = vmgName() || 'Vmg';
    
    if (maptype === "WIND") {
      return tws;
    } else if (maptype === "VMG%") {
      return vmgPerc;
    } else if (maptype === "VMG") {
      return vmg;
    } else {
      // DEFAULT or undefined - use Bsp
      return bsp;
    }
  };

  /** Timeline Y value: matches map color mode and coalesces BSP/TWS/VMG columns across kph/kts. */
  const getTimelineYValue = (d: any): number => {
    if (!d) return 0;
    const ch = getChannelName();
    const mt = props.maptype ?? "DEFAULT";
    return mapTimelineChannelValue(d as Record<string, unknown>, ch, mt);
  };

  // Media windows for videoOnly mode (same API as MapTimeSeries)
  const fetchMediaSources = async (dateYmd: string) => {
    try {
      const cls = persistantStore.selectedClassName && persistantStore.selectedClassName();
      const proj = persistantStore.selectedProjectId && persistantStore.selectedProjectId();
      if (!cls || !proj) return [];
      const url = `/api/media/sources?class_name=${encodeURIComponent(cls)}&project_id=${encodeURIComponent(proj)}&date=${encodeURIComponent(dateYmd)}`;
      debug('MultiMapTimeSeries: Fetching media sources from:', url);
      const response = await getData(url);
      if (!response.success || response.data == null) return [];
      const list = Array.isArray(response.data) ? response.data : [];
      return list.map((r: any, i: number) => ({
        id: r.id || r.media_source || r.name || `src_${i}`,
        name: r.name || r.media_source || r.id || `Source ${i + 1}`,
      }));
    } catch (error: unknown) {
      logError('MultiMapTimeSeries: Error fetching media sources', error as Error);
      return [];
    }
  };

  const fetchMediaForSource = async (sourceId: string | number, dateYmd: string) => {
    try {
      const cls = persistantStore.selectedClassName && persistantStore.selectedClassName();
      const proj = persistantStore.selectedProjectId && persistantStore.selectedProjectId();
      if (!cls || !proj) return [];
      const url = `/api/media?class_name=${encodeURIComponent(cls)}&project_id=${encodeURIComponent(proj)}&date=${encodeURIComponent(dateYmd)}&media_source=${encodeURIComponent(String(sourceId))}`;
      const response = await getData(url);
      if (!response.success || response.data == null) return [];
      const list = Array.isArray(response.data) ? response.data : [];
      return list.map((r: any) => {
        const start = r.start_time || r.start || r.begin || r.ts_start;
        const end = r.end_time || r.end || r.finish || r.ts_end;
        const startDate = start ? new Date(start) : null;
        const endDate = end ? new Date(end) : null;
        if (!startDate || !endDate || isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return null;
        return { start: startDate, end: endDate, ...r };
      }).filter(Boolean);
    } catch (error: unknown) {
      logError('MultiMapTimeSeries: Error fetching media for source', error as Error);
      return [];
    }
  };

  const fetchMediaDataForSelectedSources = async (dateYmd: string) => {
    const currentIds = getSelectedSourceIds();
    const selected = currentIds instanceof Set ? currentIds : new Set<number>();
    if (selected.size === 0) {
      setMediaWindows([]);
      return;
    }
    try {
      const sources = await fetchMediaSources(dateYmd);
      if (sources.length === 0) {
        setMediaWindows([]);
        return;
      }
      const allWindows: any[] = [];
      for (const ms of sources) {
        const msIdStr = String(ms.id);
        const msIdNum = Number(ms.id);
        const matchesSelected =
          (Number.isFinite(msIdNum) && selected.has(msIdNum)) ||
          Array.from(selected).some(
            (sid) =>
              sid === msIdNum ||
              sourcesStore.getSourceName(sid) === msIdStr ||
              sourcesStore.getSourceName(sid) === (ms.name ?? '')
          );
        if (!matchesSelected) continue;
        const media = await fetchMediaForSource(ms.id, dateYmd);
        media.forEach((item: any) => allWindows.push({ sourceId: ms.id, ...item }));
      }
      debug('MultiMapTimeSeries: Fetched media windows for videoOnly', { count: allWindows.length });
      setMediaWindows(allWindows);
    } catch (error: unknown) {
      logError('MultiMapTimeSeries: Error fetching media data', error as Error);
      setMediaWindows([]);
    }
  };

  // Historical data lives in IndexedDB - query it directly, not through props

  // Fetch and combine data from unified store (for post-processed data)
  // Made fully async and non-blocking to improve load performance
  const fetchCombinedData = async () => {
    const onLoading = props.onLoadingChange;
    try {
      if (typeof onLoading === 'function') onLoading(true);
      const cls = persistantStore.selectedClassName && persistantStore.selectedClassName();
      const proj = persistantStore.selectedProjectId && persistantStore.selectedProjectId();
      // Use selectedDate from persistantStore as the source of truth (matches MapContainer)
      let day = persistantStore.selectedDate && persistantStore.selectedDate();
      if (!cls || !proj || !day) {
        debug('MultiMapTimeSeries: Missing required params', { cls, proj, day });
        setCombinedData([]);
        safeOnMapUpdate([]);
        return;
      }
      const ymd = String(day).replace(/[-/]/g, '');
      
      // Get selected source IDs to filter data fetching
      const currentSelectedIds = getSelectedSourceIds();
      const selectedIds = currentSelectedIds instanceof Set ? currentSelectedIds : undefined;
      
      // Fetch data asynchronously without blocking - use Promise to ensure it's truly async
      const fetchPromise = unifiedDataStore.fetchMapDataForDay(cls, Number(proj), ymd, selectedIds);
      
      // Allow UI to remain responsive by yielding to event loop
      // This ensures the fetch doesn't block rendering
      await new Promise(resolve => setTimeout(resolve, 0));
      
      const results = await fetchPromise;
      
      // Validate data structure and log sample
      if (Array.isArray(results) && results.length > 0) {
        const samplePoint = results[0];
        const hasSourceId = samplePoint?.source_id !== undefined || samplePoint?.sourceId !== undefined;
        const hasLat = samplePoint?.Lat_dd !== undefined || samplePoint?.lat_dd !== undefined || 
                     samplePoint?.Lat !== undefined || samplePoint?.lat !== undefined;
        const hasLng = samplePoint?.Lng_dd !== undefined || samplePoint?.lng_dd !== undefined || 
                     samplePoint?.Lng !== undefined || samplePoint?.lng !== undefined;
        
        debug('MultiMapTimeSeries: fetchMapDataForDay returned data', {
          totalRows: results.length,
          samplePoint: {
            hasSourceId,
            hasLat,
            hasLng,
            source_id: samplePoint?.source_id,
            sourceId: samplePoint?.sourceId,
            Lat_dd: samplePoint?.Lat_dd,
            Lng_dd: samplePoint?.Lng_dd,
            keys: Object.keys(samplePoint || {}).slice(0, 15)
          }
        });
        
        if (!hasSourceId) {
          logWarn('MultiMapTimeSeries: WARNING - Data missing source_id field', {
            samplePoint: samplePoint,
            allKeys: Object.keys(samplePoint || {})
          });
        }
        
        if (!hasLat || !hasLng) {
          logWarn('MultiMapTimeSeries: WARNING - Data missing lat/lng fields', {
            hasLat,
            hasLng,
            samplePoint: samplePoint,
            allKeys: Object.keys(samplePoint || {})
          });
        }
        
        // Validate that the returned data matches the requested date
        const sampleDate = samplePoint?.Datetime;
        if (sampleDate) {
          const dataDate = new Date(sampleDate);
          const requestedDate = new Date(day);
          const dateMatch = dataDate.getFullYear() === requestedDate.getFullYear() &&
                           dataDate.getMonth() === requestedDate.getMonth() &&
                           dataDate.getDate() === requestedDate.getDate();
          if (!dateMatch) {
            logWarn('MultiMapTimeSeries: Date mismatch detected', {
              requestedDate: day,
              dataDate: sampleDate,
              dataDateFormatted: dataDate.toISOString().split('T')[0],
              requestedDateFormatted: requestedDate.toISOString().split('T')[0]
            });
          }
        }
      } else {
        debug('MultiMapTimeSeries: fetchMapDataForDay returned no data', {
          resultsType: Array.isArray(results) ? 'array' : typeof results,
          resultsLength: Array.isArray(results) ? results.length : 'N/A'
        });
      }

          // Store RAW data (no race filtering here - we'll do that reactively in a memo)
          // Just store all data for the day
          // CRITICAL: Normalize source_id field before storing to ensure consistency
          const normalizedResults = results.map(pt => {
            // Normalize source_id field name - ensure it's always 'source_id' (lowercase)
            if (pt.sourceId !== undefined && pt.source_id === undefined) {
              pt.source_id = Number(pt.sourceId);
            } else if (pt.Source_id !== undefined && pt.source_id === undefined) {
              pt.source_id = Number(pt.Source_id);
            } else if (pt.sourceID !== undefined && pt.source_id === undefined) {
              pt.source_id = Number(pt.sourceID);
            }
            // Ensure source_id is a number
            if (pt.source_id !== undefined) {
              pt.source_id = Number(pt.source_id);
            }
            return pt;
          });
          
          setCombinedData(normalizedResults);
          
          // Send data to map immediately after fetch completes
          // This ensures tracks appear even if the reactive effect hasn't triggered yet
          // Apply basic source filtering (race/leg filtering will be handled by reactive effect)
          if (normalizedResults && normalizedResults.length > 0 && !isVideoContext() && typeof onMapUpdate === 'function') {
            const currentSelectedIds = getSelectedSourceIds();
            const selected = currentSelectedIds instanceof Set ? currentSelectedIds : new Set();
            
            // Filter by selected sources if any are selected, otherwise send all data
            // MultiTrackLayer can handle empty selectedSourceIds by defaulting to all sources in data
            let filteredData = normalizedResults;
            if (selected.size > 0) {
              filteredData = normalizedResults.filter(pt => {
                const sid = Number(pt?.source_id ?? pt?.sourceId ?? pt?.Source_id ?? pt?.sourceID);
                return Number.isFinite(sid) && selected.has(sid);
              });
              debug('MultiMapTimeSeries: Filtered data by selected sources', {
                before: normalizedResults.length,
                after: filteredData.length,
                selectedSources: Array.from(selected)
              });
            } else {
              debug('MultiMapTimeSeries: No sources selected, sending all data (MultiTrackLayer will handle)', {
                totalData: normalizedResults.length
              });
            }
            
            if (filteredData && filteredData.length > 0) {
              // Validate data structure before sending - ensure all points have source_id
              const pointsWithoutSourceId = filteredData.filter(pt => 
                !pt.source_id && pt.sourceId === undefined && pt.Source_id === undefined && pt.sourceID === undefined
              );
              
              if (pointsWithoutSourceId.length > 0) {
                logWarn('MultiMapTimeSeries: WARNING - Some data points missing source_id field', {
                  totalPoints: filteredData.length,
                  pointsWithoutSourceId: pointsWithoutSourceId.length,
                  sampleMissing: pointsWithoutSourceId[0] ? Object.keys(pointsWithoutSourceId[0]).slice(0, 10) : []
                });
                // Filter out points without source_id to prevent rendering issues
                filteredData = filteredData.filter(pt => 
                  pt.source_id !== undefined || pt.sourceId !== undefined || pt.Source_id !== undefined || pt.sourceID !== undefined
                );
              }
              
              // Verify data structure before sending
              const samplePoint = filteredData[0];
              const hasSourceId = samplePoint?.source_id !== undefined || samplePoint?.sourceId !== undefined;
              const hasLat = samplePoint?.Lat_dd !== undefined || samplePoint?.lat_dd !== undefined || 
                           samplePoint?.Lat !== undefined || samplePoint?.lat !== undefined;
              const hasLng = samplePoint?.Lng_dd !== undefined || samplePoint?.lng_dd !== undefined || 
                           samplePoint?.Lng !== undefined || samplePoint?.lng !== undefined;
              
              // Get unique source IDs for logging
              const uniqueSourceIds = [...new Set(filteredData.map(pt => 
                Number(pt?.source_id ?? pt?.sourceId ?? pt?.Source_id ?? pt?.sourceID ?? 0)
              ).filter(id => Number.isFinite(id) && id > 0))];
              
              debug('MultiMapTimeSeries: Sending initial data to map after fetch', { 
                totalData: normalizedResults.length, 
                filteredData: filteredData.length,
                selectedSources: selected.size > 0 ? Array.from(selected) : 'all',
                uniqueSourceIds: uniqueSourceIds.slice(0, 10),
                sourceCount: uniqueSourceIds.length,
                samplePoint: {
                  hasSourceId,
                  hasLat,
                  hasLng,
                  source_id: samplePoint?.source_id,
                  sourceId: samplePoint?.sourceId,
                  Lat_dd: samplePoint?.Lat_dd,
                  Lng_dd: samplePoint?.Lng_dd,
                  keys: Object.keys(samplePoint || {}).slice(0, 10)
                }
              });
              
              if (!hasSourceId) {
                logWarn('MultiMapTimeSeries: WARNING - Data missing source_id field', {
                  samplePoint: samplePoint,
                  allKeys: Object.keys(samplePoint || {})
                });
              }
              
              if (!hasLat || !hasLng) {
                logWarn('MultiMapTimeSeries: WARNING - Data missing lat/lng fields', {
                  hasLat,
                  hasLng,
                  samplePoint: samplePoint,
                  allKeys: Object.keys(samplePoint || {})
                });
              }
              
              safeOnMapUpdate(filteredData);
            } else {
              debug('MultiMapTimeSeries: No filtered data to send', {
                totalData: normalizedResults.length,
                selectedSources: selected.size > 0 ? Array.from(selected) : 'all',
                filteredDataLength: filteredData?.length || 0
              });
            }
          }
      // videoOnly mode: fetch media windows for selected sources (use selectedIds from top of fetch)
      if (props.videoOnly && selectedIds && selectedIds.size > 0) {
        await fetchMediaDataForSelectedSources(ymd);
      } else if (props.videoOnly) {
        setMediaWindows([]);
      }
    } catch (e) {
      logWarn('MultiMapTimeSeries: Fetch failed', e);
      setCombinedData([]);
      safeOnMapUpdate([]);
    } finally {
      if (typeof onLoading === 'function') onLoading(false);
    }
  };

  // Helper function to get filtered data (by sources, races, legs, and time window) - for use in brush handlers
  const getFilteredData = (dataOverride) => {
    const data = dataOverride || combinedData();
    const currentSelectedIds = getSelectedSourceIds();
    let selected = currentSelectedIds instanceof Set ? currentSelectedIds : new Set();
    const races = Array.isArray(props.selectedRacesTimeseries) ? props.selectedRacesTimeseries : (Array.isArray(props.selectedRaces) ? props.selectedRaces : (globalSelectedRaces && globalSelectedRaces()));
    const legs = Array.isArray(props.selectedLegsTimeseries) ? props.selectedLegsTimeseries : (Array.isArray(props.selectedLegs) ? props.selectedLegs : (globalSelectedLegs && globalSelectedLegs()));

    if (data.length === 0) {
      return [];
    }

    // Normalize source_id field before filtering to ensure consistency
    const normalizedData = data.map(pt => {
      // Normalize source_id field name - ensure it's always 'source_id' (lowercase)
      if (pt.sourceId !== undefined && pt.source_id === undefined) {
        pt.source_id = Number(pt.sourceId);
      } else if (pt.Source_id !== undefined && pt.source_id === undefined) {
        pt.source_id = Number(pt.Source_id);
      } else if (pt.sourceID !== undefined && pt.source_id === undefined) {
        pt.source_id = Number(pt.sourceID);
      }
      // Ensure source_id is a number
      if (pt.source_id !== undefined) {
        pt.source_id = Number(pt.source_id);
      }
      return pt;
    });

    // In day multi mode, empty source selection means "all sources" (same as MapContainer/MultiTrackLayer)
    if (selected.size === 0 && normalizedData.length > 0) {
      const sourcesInData = new Set<number>();
      for (const pt of normalizedData) {
        const sid = Number(sourceKey(pt));
        if (Number.isFinite(sid)) sourcesInData.add(sid);
      }
      if (sourcesInData.size > 0) {
        selected = sourcesInData;
        debug('MultiMapTimeSeries: Empty source selection — using all sources from data', { count: selected.size, sourceIds: Array.from(selected).slice(0, 15) });
      } else {
        return [];
      }
    }

    // First, filter by selected sources
    let filteredData = normalizedData.filter(pt => {
      const sid = Number(sourceKey(pt));
      return Number.isFinite(sid) && selected.has(sid);
    });
    

    // Then, apply race filtering if races are selected
    if (Array.isArray(races) && races.length > 0) {
      const chosen = races[0];
      
      // Validate chosen race value - skip if invalid
      if (chosen === undefined || chosen === null || chosen === '') {
        debug(`MultiMapTimeSeries: Skipping race filter - chosen race is invalid (${chosen}). Showing all data.`);
      } else {
        // First, check if the data actually has race numbers
        const raceNumbersInData = [...new Set(filteredData.map(p => {
          const rnum = Number(p.Race_number ?? p.Race ?? p.race_number);
          return Number.isFinite(rnum) ? rnum : null;
        }).filter(n => n !== null))].sort((a, b) => a - b);
        
        // Only apply race filter if the data actually has race numbers
        // If no race numbers are found in the data, skip the filter (show all data)
        if (raceNumbersInData.length > 0) {
          // Check if chosen race exists in the data
          // Handle 'TRAINING' string or numeric race values
          const chosenRaceNum = chosen === 'TRAINING' ? -1 : Number(chosen);
          
          // Skip if conversion resulted in NaN
          if (!Number.isFinite(chosenRaceNum)) {
            debug(`MultiMapTimeSeries: Skipping race filter - chosen race ${chosen} cannot be converted to a valid number. Showing all data.`);
          } else {
            // For 'TRAINING', check if -1 exists in data; for numeric races, check if the number exists
            const raceToCheck = chosen === 'TRAINING' ? -1 : chosenRaceNum;
            const raceExists = raceNumbersInData.includes(raceToCheck);
            
            if (!raceExists) {
              // Selected race doesn't exist in data - skip filter and show all data
              debug(`MultiMapTimeSeries: Skipping race filter - chosen race ${chosenRaceNum} not in data. Available races: [${raceNumbersInData.join(', ')}]. Showing all data.`);
            } else {
              // Simple filter: only keep points that match the selected race number
              const beforeCount = filteredData.length;
              filteredData = filteredData.filter((p) => {
                const rnum = Number(p.Race_number ?? p.Race ?? p.race_number);
                // For 'TRAINING', match -1; for numeric races, match the number
                const matches = Number.isFinite(rnum) && rnum === raceToCheck;
                return matches;
              });
              
              // If filter removed all data, log a warning
              if (filteredData.length === 0 && beforeCount > 0) {
                // Get sample from original data before filtering
                const originalData = data.filter(pt => {
                  const sid = Number(sourceKey(pt));
                  return Number.isFinite(sid) && selected.has(sid);
                });
                debug('MultiMapTimeSeries: WARNING - Race filter removed all data', {
                  chosenRace: chosen,
                  availableRaces: raceNumbersInData,
                  beforeFilterCount: beforeCount,
                  sampleData: originalData.slice(0, 5).map(p => ({
                    Race_number: p.Race_number,
                    Race: p.Race,
                    race_number: p.race_number,
                    source_id: p.source_id
                  }))
                });
              }
            }
          }
        }
      }
    }

    // Apply leg filtering if legs are selected (compare numerically: store has string[] e.g. ['1','2'])
    if (Array.isArray(legs) && legs.length > 0) {
      const legNumbers = legs.map((l) => Number(l)).filter((n) => Number.isFinite(n));
      if (legNumbers.length > 0) {
        filteredData = filteredData.filter((p) => {
          const lnum = Number(p.leg_number ?? p.Leg_number ?? p.Leg ?? p.LEG);
          return Number.isFinite(lnum) && legNumbers.includes(lnum);
        });
        debug('MultiMapTimeSeries: Leg filter applied', {
          selectedLegs: legs,
          legNumbers,
          filteredDataCount: filteredData.length
        });
      }
    }

    return filteredData;
  };


  // Track last grouped data signature to reduce logging
  let lastGroupedDataSignature = '';
  let lastFilteredDataCount = -1;
  let lastGroupedResultSignature = '';

  // Group data by source AND apply race and leg filtering
  const groupedData = createMemo(() => {
    const data = combinedData();
    const currentSelectedIds = getSelectedSourceIds();
    const selected = currentSelectedIds instanceof Set ? currentSelectedIds : new Set();
    const races = Array.isArray(props.selectedRacesTimeseries) ? props.selectedRacesTimeseries : (Array.isArray(props.selectedRaces) ? props.selectedRaces : (globalSelectedRaces && globalSelectedRaces()));
    const legs = Array.isArray(props.selectedLegsTimeseries) ? props.selectedLegsTimeseries : (Array.isArray(props.selectedLegs) ? props.selectedLegs : (globalSelectedLegs && globalSelectedLegs()));
    
    // Create signature to detect actual changes
    const signature = `${data.length}_${Array.from(selected).sort().join(',')}_${Array.isArray(races) ? races.join(',') : ''}_${Array.isArray(legs) ? legs.join(',') : ''}`;
    
    // Only log when data actually changes
    if (signature !== lastGroupedDataSignature) {
      lastGroupedDataSignature = signature;
    }

    if (data.length === 0) {
      return [];
    }

    let dataToUse = data;

    // Get filtered data (applies source, race, and leg filters; empty source selection => all sources from data)
    // Pass dataToUse directly to avoid mutating the signal (which causes infinite loops)
    let filteredData = getFilteredData(dataToUse);

    // Video-only mode: restrict to time ranges where media exists for selected sources.
    // When media windows are not loaded yet, show full filtered data so the chart is visible; once windows load we filter to video-only.
    if (props.videoOnly) {
      const windows = mediaWindows();
      if (windows.length > 0) {
        filteredData = filteredData.filter((d: any) => {
          const t = d?.Datetime ?? d?.timestamp ?? d?.time ?? d?.datetime;
          if (!t) return false;
          const tMs = t instanceof Date ? t.getTime() : new Date(t).getTime();
          if (!Number.isFinite(tMs)) return false;
          return windows.some(
            (w: any) =>
              w.start &&
              w.end &&
              tMs >= (w.start instanceof Date ? w.start.getTime() : new Date(w.start).getTime()) &&
              tMs <= (w.end instanceof Date ? w.end.getTime() : new Date(w.end).getTime())
          );
        });
        debug('MultiMapTimeSeries: videoOnly filter', { windowsCount: windows.length, resultLength: filteredData.length });
      }
      // else: keep filteredData as-is so the timeline is visible while media windows load
    }

    // Track filtered data count changes
    if (filteredData.length !== lastFilteredDataCount) {
      lastFilteredDataCount = filteredData.length;
    }

    // Now group the filtered data by source
    const groups = new Map();
    for (const pt of filteredData) {
      const sid = Number(sourceKey(pt));
      if (!Number.isFinite(sid)) continue;
      if (!groups.has(sid)) groups.set(sid, []);
      groups.get(sid).push(pt);
    }

    // Get source info from store
    const sources = sourcesStore.sources();
    const result = Array.from(groups.entries()).map(([sid, points]) => {
      const sourceInfo = sources.find(s => Number(s.source_id) === Number(sid));
      const color = sourceInfo?.color || '#1f77b4';
      const name = sourceInfo?.source_name || String(sid);
      
      // Sort by timestamp
      const sorted = [...points].sort((a, b) => {
        const aTime = new Date(a.Datetime || a.timestamp || a.time).getTime();
        const bTime = new Date(b.Datetime || b.timestamp || b.time).getTime();
        return aTime - bTime;
      });
      
      
      return { sourceId: sid, sourceName: name, color, data: sorted };
    });

    // Create signature for grouped result to reduce logging
    const resultSignature = `${result.length}_${result.map(g => `${g.sourceId}:${g.data.length}`).join(',')}`;
    if (resultSignature !== lastGroupedResultSignature) {
      lastGroupedResultSignature = resultSignature;
    }

    return result;
  });

  // ============================================================================
  // Get time extent across all sources
  // When selectedRange has one range (e.g. from FleetMap brush), use it so FleetVideo timeline stays in sync with map
  // Otherwise show all data from min to max
  // ============================================================================
  const timeExtent = createMemo(() => {
    const range = selectedRange();
    if (Array.isArray(range) && range.length === 1 && range[0]?.start_time && range[0]?.end_time) {
      const start = new Date(range[0].start_time);
      const end = new Date(range[0].end_time);
      if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && start.getTime() < end.getTime()) {
        return [start, end];
      }
    }

    const groups = groupedData();
    if (groups.length === 0) {
      // Return a valid default range (24 hours)
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      return [now, tomorrow];
    }
    
    let minTime = Infinity;
    let maxTime = -Infinity;
    
    for (const group of groups) {
      for (const d of group.data) {
        const t = new Date(d.Datetime || d.timestamp || d.time).getTime();
        if (t < minTime) minTime = t;
        if (t > maxTime) maxTime = t;
      }
    }
    
    // Ensure we have valid times
    if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      return [now, tomorrow];
    }
    
    // Show all data from min to max
    return [new Date(minTime), new Date(maxTime)];
  });

  // Get value extent (e.g., Bsp) across all sources
  const valueExtent = createMemo(() => {
    const groups = groupedData();
    if (groups.length === 0) return [0, 100];
    
    let minVal = Infinity;
    let maxVal = -Infinity;
    
    for (const group of groups) {
      for (const d of group.data) {
        const val = getTimelineYValue(d);
        if (Number.isFinite(val)) {
          if (val < minVal) minVal = val;
          if (val > maxVal) maxVal = val;
        }
      }
    }
    
    // Ensure we have valid values
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal) || minVal === Infinity) {
      return [0, 100];
    }
    
    return [minVal * 0.95, maxVal * 1.05]; // Add 5% padding
  });

  // Helper function to get timestamp from data point
  const getTimestamp = (d) => {
    if (!d) return new Date(0);
    const timestamp = d.Datetime || d.timestamp || d.time || d.datetime;
    if (!timestamp) return new Date(0);
    if (timestamp instanceof Date) return timestamp;
    if (typeof timestamp === 'number') return new Date(timestamp);
    if (typeof timestamp === 'string') {
      const parsed = new Date(timestamp);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    return new Date(0);
  };

  // Initialize SVG
  const initSVG = () => {
    if (!chartContainer) return;
    
    const bbox = chartContainer.getBoundingClientRect();
    // Add extra height for x-axis labels that extend below the axis
    const labelPadding = 20; // Extra space for axis labels
    const svgHeight = bbox.height + labelPadding;
    setDimensions({ width: bbox.width, height: bbox.height });
    
    // Remove existing SVG
    d3.select(chartContainer).selectAll("svg").remove();
    
    svg = d3.select(chartContainer)
      .append("svg")
      .attr("width", bbox.width)
      .attr("height", svgHeight)
      .style("position", "absolute")
      .style("top", "0")
      .style("left", "0")
      .style("z-index", "10")
      .style("pointer-events", "auto");
    
    // Create scales
    const [minTime, maxTime] = timeExtent();
    const [minVal, maxVal] = valueExtent();
    
    // Validate time extent
    if (!minTime || !maxTime || isNaN(minTime.getTime()) || isNaN(maxTime.getTime()) || minTime.getTime() === maxTime.getTime()) {
      logWarn('MultiMapTimeSeries: Invalid time extent, using default', {
        minTime: minTime?.toISOString(),
        maxTime: maxTime?.toISOString()
      });
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      xScale = d3.scaleTime()
        .domain([now, tomorrow])
        .range([margin.left, bbox.width - margin.right]);
    } else {
      xScale = d3.scaleTime()
        .domain([minTime, maxTime])
        .range([margin.left, bbox.width - margin.right]);
    }
    
    yScale = d3.scaleLinear()
      .domain([minVal, maxVal])
      .range([bbox.height - margin.bottom, margin.top]);

    const getThemeColor = (lightColor, darkColor) => {
      return themeStore.isDark() ? darkColor : lightColor;
    };
    
    // Add axes (let D3 auto-format time based on range, same as MapTimeSeries)
    const axiscolor = getThemeColor('#374151', '#cbd5e1');
    
    // Create axes with explicit styling
    const timezone = getTimezone();
    debug('🕐 MultiMapTimeSeries.initSVG: Using timezone for x-axis formatting', {
      timezone: timezone,
      timezoneType: typeof timezone,
      isNull: timezone === null,
      isUndefined: timezone === undefined
    });
    const xAxis = d3.axisBottom(xScale)
      .ticks(5)
      .tickFormat((d) => {
        if (d instanceof Date) {
          const formatted = formatTime(d, timezone);
          return formatted || d.toLocaleTimeString();
        }
        return String(d);
      });
    const yAxis = d3.axisLeft(yScale).ticks(5);
    
    // X-axis
    const xAxisGroup = svg.append("g")
      .attr("class", "axes")
      .attr("data-axis", "x")
      .attr("transform", `translate(0, ${bbox.height - margin.bottom})`)
      .call(xAxis);
    
    // Force style on all text elements - use each() to ensure it applies
    xAxisGroup.selectAll("text")
      .each(function() {
        d3.select(this)
          .attr("fill", axiscolor)
          .style("fill", axiscolor)
          .style("color", axiscolor)
          .style("opacity", 1);
      });
    xAxisGroup.selectAll("path, line")
      .style("stroke", axiscolor);
    
    // Y-axis
    const yAxisGroup = svg.append("g")
      .attr("class", "axes")
      .attr("data-axis", "y")
      .attr("transform", `translate(${margin.left}, 0)`)
      .call(yAxis);
    
    // Force style on all text elements - use each() to ensure it applies
    yAxisGroup.selectAll("text")
      .each(function() {
        d3.select(this)
          .attr("fill", axiscolor)
          .style("fill", axiscolor)
          .style("color", axiscolor)
          .style("opacity", 1);
      });
    yAxisGroup.selectAll("path, line")
      .style("stroke", axiscolor);
    
    // Add Y-axis label (similar to MapTimeSeries)
    const channel = getChannelName();
    const labelParts = mapTimelineYAxisLabelParts(channel, persistantStore.defaultUnits());
    const textColor = getThemeColor('#374151', '#cbd5e1'); // Use same color as axis
    const axisLabelEl = svg
      .append("text")
      .attr("class", "axis-label")
      .attr("text-anchor", "left")
      .attr("transform", "translate(20,15)")
      .attr("font-size", "14px")
      .attr("fill", textColor);
    axisLabelEl.append("tspan").text(labelParts.name);
    if (labelParts.unitBracket != null) {
      axisLabelEl
        .append("tspan")
        .attr("class", "map-timeseries-axis-unit")
        .text(labelParts.unitBracket);
    }
    
    // Brush disabled - create simple clickable overlay for time selection only
    brush = null; // No brush object needed
    brushGroup = svg.append("g")
      .attr("class", "brush")
      .on("contextmenu", (event) => event.preventDefault());
    
    // Create clickable overlay rectangle (replaces brush overlay)
    const overlayWidth = bbox.width - margin.left - margin.right;
    const overlayHeight = bbox.height - margin.top - margin.bottom;
    brushGroup.append("rect")
      .attr("class", "overlay")
      .attr("x", margin.left)
      .attr("y", margin.top)
      .attr("width", overlayWidth)
      .attr("height", overlayHeight)
      .style("fill", "none")
      .style("pointer-events", "all")
      .style("cursor", "pointer")
      .on("click", (event) => {
        // Click to change selected time
        const [mouseX] = d3.pointer(event, svg.node());
        // xScale range already accounts for margin, so use mouseX directly
        const time = xScale.invert(mouseX);
        
        if (requestTimeControl('multimaptimeseries')) {
          setIsManualTimeChange(true);
          setSelectedTime(new Date(time), 'multimaptimeseries');
          if (onStableSelectedTimeChange) {
            onStableSelectedTimeChange(new Date(time));
          }
          
          setTimeout(() => {
            releaseTimeControl('multimaptimeseries');
          }, 100);
        }
        
        // Send filtered data if no active brush selection
        const hasRange = Array.isArray(selectedRange()) && selectedRange().length > 0;
        if (!hasRange) {
          const fullData = getFilteredData();
          safeOnMapUpdate(fullData);
        }
      })
      .on("dblclick", (event) => {
        // Double-click to clear selection
        event.preventDefault();
        event.stopPropagation();
        handleBrushClear();
      });

    // Playhead on top of overlay: red line + downward triangle, draggable (hover over line disables overlay click)
    const triangleSize = 8;
    const playheadY1 = 0; // Line starts at top (below triangle base)
    const playheadY2 = overlayHeight; // Full height to bottom of plot
    playheadGroup = svg.append("g")
      .attr("class", "playhead-group")
      .style("opacity", 1);

    playheadGroup.append("line")
      .attr("class", "mouse-line")
      .attr("stroke", "red")
      .attr("stroke-width", 2)
      .attr("x1", 0)
      .attr("x2", 0)
      .attr("y1", playheadY1)
      .attr("y2", playheadY2)
      .style("pointer-events", "none");

    playheadGroup.append("path")
      .attr("class", "playhead-triangle")
      .attr("d", `M ${-triangleSize / 2},0 L ${triangleSize / 2},0 L 0,${triangleSize} Z`)
      .attr("fill", "red")
      .attr("stroke", "red")
      .attr("stroke-width", 1)
      .style("pointer-events", "all");

    playheadGroup.append("rect")
      .attr("class", "playhead-drag-handle")
      .attr("x", -10)
      .attr("y", 0)
      .attr("width", 20)
      .attr("height", triangleSize + 4)
      .attr("fill", "transparent")
      .style("pointer-events", "all");

    playheadGroup.append("rect")
      .attr("class", "playhead-line-hit")
      .attr("x", -4)
      .attr("y", playheadY1)
      .attr("width", 8)
      .attr("height", playheadY2 - playheadY1)
      .attr("fill", "transparent")
      .style("pointer-events", "all");

    const playheadDrag = d3.drag()
      .on("start", () => {
        playheadGroup.classed("dragging", true);
      })
      .on("drag", (event) => {
        let mx: number;
        try {
          [mx] = d3.pointer(event, svg.node());
        } catch {
          return;
        }
        if (!Number.isFinite(mx)) return;
        const range = xScale.range();
        const x = Math.max(range[0], Math.min(range[1], mx));
        if (!Number.isFinite(x)) return;
        const time = new Date(xScale.invert(x));
        if (requestTimeControl('multimaptimeseries')) {
          setIsManualTimeChange(true);
          setSelectedTime(time, 'multimaptimeseries');
          if (onStableSelectedTimeChange) onStableSelectedTimeChange(time);
          playheadGroup.attr("transform", `translate(${x}, ${margin.top})`);
        }
      })
      .on("end", () => {
        playheadGroup.classed("dragging", false);
        setTimeout(() => releaseTimeControl('multimaptimeseries'), 100);
      });

    playheadGroup.call(playheadDrag);

    const initialTime = selectedTime() || (xScale.domain()[0]);
    const initialX = xScale(initialTime);
    if (Number.isFinite(initialX)) {
      playheadGroup.attr("transform", `translate(${initialX}, ${margin.top})`);
    }

    // Brush handlers disabled - only allow click to change selected time
    // brush.on("brush", brushed).on("end", brushEnded).on("start", null);

    // Brush selection restoration disabled - brush events are disabled
    // restoreBrushSelection();

  };

  // Helper function to restore brush selection
  const restoreBrushSelection = () => {
    if (!brushGroup || !xScale) return;
    
    const currentSelectedRange = selectedRange();
    const currentCutEvents = cutEvents();
    
    if (currentSelectedRange && currentSelectedRange.length > 0) {
      const rangeItem = currentSelectedRange[0];
      const startTime = new Date(rangeItem.start_time);
      const endTime = new Date(rangeItem.end_time);
      
      const x0 = xScale(startTime);
      const x1 = xScale(endTime);
      
      brushGroup.call(brush.move, [x0, x1]);
    } else if (currentCutEvents && currentCutEvents.length > 0) {
      brushGroup.call(brush.move, null);
    } else {
      brushGroup.call(brush.move, null);
    }
  };

  // Helper function to update time selection
  const updateTimeSelection = (time) => {
    if (requestTimeControl('multimaptimeseries')) {
      try { (window).skipBoatHaloOnce = true; } catch {}
      if (!isManualTimeChange()) setIsManualTimeChange(true);
      const newTime = new Date(time);
      const current = selectedTime();
      if (!(current instanceof Date) || Math.abs(current.getTime() - newTime.getTime()) > 0) {
        setSelectedTime(newTime, 'multimaptimeseries');
      }
      if (onStableSelectedTimeChange) {
        onStableSelectedTimeChange(newTime);
      }
      prevSelectedTime = newTime;
      
      setTimeout(() => {
        releaseTimeControl('multimaptimeseries');
      }, 100);
    }
  };

  // Helper function to handle brush clearing
  const handleBrushClear = () => {
    setSelectedRange([]);
    setSelectedRanges([]);
    setSelectedEvents([]);
    setHasSelection(false);
    setIsCut(cutEvents().length > 0);
    
    const fullData = getFilteredData();
    
    if (fullData && fullData.length > 0) {
      lastMapUpdateSignature = null;
      const timestampedData = fullData.map((d, index) => ({
        ...d,
        _clearTimestamp: Date.now() + index
      }));
      
      safeOnMapUpdate(timestampedData);
    }
  };

  // Helper function to clear brush (brush is disabled, just clear selection state)
  const clearBrush = () => {
      if (isClearingBrush) {
        return;
      }
    
    isClearingBrush = true;
    
    try {
      // Brush is disabled, so no need to call brush.move
      // Just clear the selection state
      handleBrushClear();
    } finally {
      setTimeout(() => {
        isClearingBrush = false;
        isProgrammaticallyUpdatingBrush = false;
      }, 100);
    }
  };

  // Helper function to handle brush selection (matching MapTimeSeries pattern)
  const handleBrushSelection = async (x0, x1) => {
    const minSelectionMs = 1000;
    const selectionDuration = Math.abs(x1 - x0);

    if (selectionDuration > minSelectionMs) {
      const startTime = new Date(x0);
      const endTime = new Date(x1);
      
      // IMPORTANT: Always send FULL timeline data to map
      // MultiTrackLayer will handle brush filtering using selectedRange/selectedRanges
      // Do NOT filter data here - that causes props.data to be filtered
      const fullData = getFilteredData(); // Full timeline (filtered only by source/race/leg)
      
      lastMapUpdateSignature = null;
      const timestampedData = fullData.map((d, index) => ({
        ...d,
        _brushTimestamp: Date.now() + index
      }));
      
      safeOnMapUpdate(timestampedData);

      // Match MapTimeSeries pattern - convert Date objects to ISO strings for consistency
      const range = {"type": "range", "start_time": startTime.toISOString(), "end_time": endTime.toISOString()};
      updateTimeSelection(x0);
      
      setSelectedRange([range]);
      setHasSelection(true);
      setIsCut(false);
    } else {
      updateTimeSelection(x0);
      
      setSelectedRange([]);
      setHasSelection(false);

      // IMPORTANT: Always send FULL timeline data to map
      const fullData = getFilteredData(); // Full timeline (filtered only by source/race/leg)
      
      lastMapUpdateSignature = null;
      const timestampedData = fullData.map((d, index) => ({
        ...d,
        _brushTimestamp: Date.now() + index
      }));

      safeOnMapUpdate(timestampedData);
    }
  };

  // Brush handler
  function brushed(event) {
    if (brushTimeout) clearTimeout(brushTimeout);
    
    brushTimeout = setTimeout(() => {
      if (isBrushActive) return;
      isBrushActive = true;
      
      try {
        if (event && event.selection) {
          const [x0, x1] = event.selection.map(xScale.invert);
          const selectionDuration = Math.abs(x1 - x0);
          
          updateTimeSelection(x0);
          
          // IMPORTANT: Always send FULL timeline data to map
          // MultiTrackLayer will handle brush filtering using selectedRange/selectedRanges
          // Do NOT filter data here - that causes props.data to be filtered
          if (selectionDuration > 1000) {
            const fullData = getFilteredData(); // Full timeline (filtered only by source/race/leg)
            
            lastMapUpdateSignature = null;
            const timestampedData = fullData.map((d, index) => ({
              ...d,
              _brushTimestamp: Date.now() + index
            }));
            
            safeOnMapUpdate(timestampedData);
          }
        }
      } finally {
        isBrushActive = false;
      }
    }, 100);
  }

  // Brush ended handler (matching MapTimeSeries pattern)
  function brushEnded(event) {
    if (isProgrammaticallyUpdatingBrush) {
      isProgrammaticallyUpdatingBrush = false;
      return;
    }
    
    if (!event || !event.selection) {
      handleBrushClear();
      if (brushGroup) {
        try {
          isProgrammaticallyUpdatingBrush = true;
          brushGroup.call(brush.move, null);
        } catch(e) { /* noop */ }
      }
    } else {
      const [x0, x1] = event.selection.map(xScale.invert);
      handleBrushSelection(x0, x1);
    }
  }

  // Update axes when scales change
  // In live mode: Updates axes smoothly without clearing/recreating (prevents flashing)
  const updateAxes = () => {
    if (!svg || !xScale || !yScale) return;
    
    const getThemeColor = (lightColor, darkColor) => {
      return themeStore.isDark() ? darkColor : lightColor;
    };
    const axiscolor = getThemeColor('#374151', '#cbd5e1');
    
    // Update x-axis (let D3 auto-format, same as MapTimeSeries)
    // Use transition for smooth updates in live mode
    const timezone = getTimezone();
    debug('🕐 MultiMapTimeSeries.updateAxes: Using timezone for x-axis formatting', {
      timezone: timezone,
      timezoneType: typeof timezone,
      isNull: timezone === null,
      isUndefined: timezone === undefined
    });
    const xAxis = d3.axisBottom(xScale)
      .ticks(5)
      .tickFormat((d) => {
        if (d instanceof Date) {
          const formatted = formatTime(d, timezone);
          return formatted || d.toLocaleTimeString();
        }
        return String(d);
      });
    const xAxisGroup = svg.select("g.axes[data-axis='x']");
    
    xAxisGroup.call(xAxis);
    
    // Force style on all text elements - use each() to ensure it applies
    xAxisGroup.selectAll("text")
      .each(function() {
        d3.select(this)
          .attr("fill", axiscolor)
          .style("fill", axiscolor)
          .style("color", axiscolor)
          .style("opacity", 1);
      });
    xAxisGroup.selectAll("path, line")
      .style("stroke", axiscolor);
    
    // Update y-axis
    const yAxis = d3.axisLeft(yScale).ticks(5);
    const yAxisGroup = svg.select("g.axes[data-axis='y']");
    
    yAxisGroup.call(yAxis);
    
    // Force style on all text elements - use each() to ensure it applies
    yAxisGroup.selectAll("text")
      .each(function() {
        d3.select(this)
          .attr("fill", axiscolor)
          .style("fill", axiscolor)
          .style("color", axiscolor)
          .style("opacity", 1);
      });
    yAxisGroup.selectAll("path, line")
      .style("stroke", axiscolor);
    
    // Update Y-axis label (remove old and add new if channel changed)
    const channel = getChannelName();
    const labelParts = mapTimelineYAxisLabelParts(channel, persistantStore.defaultUnits());
    const textColor = getThemeColor('#374151', '#cbd5e1');
    svg.selectAll("text.axis-label").remove(); // Remove existing label
    const axisLabelEl = svg
      .append("text")
      .attr("class", "axis-label")
      .attr("text-anchor", "left")
      .attr("transform", "translate(60,20)")
      .attr("font-size", "14px")
      .attr("fill", textColor);
    axisLabelEl.append("tspan").text(labelParts.name);
    if (labelParts.unitBracket != null) {
      axisLabelEl
        .append("tspan")
        .attr("class", "map-timeseries-axis-unit")
        .text(labelParts.unitBracket);
    }
  };

  // Render all series
  const render = () => {
    if (!svg || !xScale || !yScale) return;
    
    const groups = groupedData();
    
    // Update axes to reflect current scale domains
    updateAxes();
    
    
    // Gap threshold: 3 seconds (timeline chart only; map uses MultiTrackLayer's threshold)
    const gapThresholdMs = 3000;
    const LEG_BOUNDARY_BRIDGE_MS = 10000; // Bridge gap at consecutive leg boundary (e.g. leg 0 -> 1) so line stays continuous

    const getLegNum = (p) => {
      const v = p?.leg_number ?? p?.Leg_number ?? p?.LEG;
      if (v === undefined || v === null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    // Helper: true = create gap (point undefined), false = no gap (point defined). Used as .defined((d,i,data) => !hasGap(d,i,data))
    const hasGap = (d, i, data) => {
      if (i === 0) return false; // Always define first point
      const prev = data[i - 1];
      const prevTime = new Date(prev.Datetime || prev.timestamp || prev.time).getTime();
      const currTime = new Date(d.Datetime || d.timestamp || d.time).getTime();
      const gap = currTime - prevTime;
      if (gap > gapThresholdMs) {
        const prevLeg = getLegNum(prev);
        const currLeg = getLegNum(d);
        const bridgeLegBoundary =
          prevLeg !== undefined &&
          currLeg !== undefined &&
          gap <= LEG_BOUNDARY_BRIDGE_MS &&
          Math.abs((currLeg ?? 0) - (prevLeg ?? 0)) === 1;
        if (bridgeLegBoundary) return false; // no gap at consecutive leg boundary
        return true; // gap
      }
      return false; // no gap
    };
    
    // Line generator with gap detection
    // Get x-axis domain to filter out points outside the scale bounds
    const xDomain = xScale.domain();
    const xMin = xDomain[0]?.getTime() ?? -Infinity;
    const xMax = xDomain[1]?.getTime() ?? Infinity;
    
    const lineGenerator = d3.line()
      .x((d) => xScale(new Date(d.Datetime || d.timestamp || d.time)))
      .y((d) => yScale(getTimelineYValue(d)))
      .defined((d, i, data) => {
        const val = getTimelineYValue(d);
        if (!Number.isFinite(val)) return false;
        
        // Check if timestamp is within x-axis domain bounds
        const timestamp = new Date(d.Datetime || d.timestamp || d.time).getTime();
        if (timestamp < xMin || timestamp > xMax) return false;
        
        // Create gap if time difference > 3 seconds
        return !hasGap(d, i, data);
      });
    
    // Render using SVG
    const paths = svg.selectAll("path.series-line")
      .data(groups, (d) => d.sourceId); // Key function for efficient updates
    
    // Exit: remove paths for deselected sources
    paths.exit().remove();
    
    // Enter: create new paths for new sources
    const pathsEnter = paths.enter()
      .append("path")
      .attr("class", "series-line")
      .attr("data-source-id", (d) => d.sourceId) // Add attribute for WebSocket updates
      .style("fill", "none")
      .style("stroke-width", "1px");
    
    // Highlight paths for hovered/selected boats (FleetMap)
    const highlighted = props.highlightedSourceIds ?? new Set<number>();
    const hasHighlight = highlighted.size > 0;

    // Update: merge enter and update selections (D3 enter-union-append pattern)
    pathsEnter.merge(paths)
      .attr("data-source-id", (d) => d.sourceId) // Ensure attribute is set
      .style("stroke", (d) => d.color)
      .style("stroke-width", (d) => (hasHighlight && highlighted.has(d.sourceId)) ? "3px" : "1px")
      .style("opacity", (d) => (hasHighlight && highlighted.has(d.sourceId)) ? 1 : (hasHighlight ? 0.3 : 1))
      .attr("d", (d) => {
        if (!d.data || d.data.length === 0) return '';
        return lineGenerator(d.data);
      });
    
    // Render cursor line
    renderCursor();
  };

  // Update playhead position for selectedTime (playhead group created in initSVG)
  const renderCursor = () => {
    if (!svg || !xScale) return;

    const currentTime = selectedTime();
    if (!currentTime) return;

    const x = xScale(currentTime);
    if (playheadGroup && Number.isFinite(x)) {
      playheadGroup.attr("transform", `translate(${x}, ${margin.top})`);
    }
  };

  // Handle resize
  const handleResize = () => {
    initSVG();
    render();
  };

  // ResizeObserver for when container gets dimensions (e.g. FleetVideo timeline); cleaned up in onCleanup
  let resizeObserver: ResizeObserver | null = null;

  // Mount
  onMount(() => {
    debug('🕐 MultiMapTimeSeries: onMount called');
    const initialTz = getCurrentDatasetTimezone();
    debug('🕐 MultiMapTimeSeries: Initial timezone on mount', {
      timezone: initialTz,
      isNull: initialTz === null,
      isUndefined: initialTz === undefined
    });
    
    window.addEventListener('resize', handleResize);
    
    if (chartContainer && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (chartContainer && groupedData().length > 0 && svg) handleResize();
      });
      resizeObserver.observe(chartContainer);
    }
    
    setTimeout(() => {
      fetchCombinedData().catch(e => logWarn('MultiMapTimeSeries: Mount fetch failed', e));
    }, 0);
  });

  // Re-fetch when dependencies change
  // Add loop detection to prevent infinite loops
  let lastFetchSignature = '';
  let fetchCount = 0;
  const MAX_FETCH_ATTEMPTS = 10;
  
  createEffect(() => {
    const _ids = getSelectedSourceIds();
    // Use selectedDate from persistantStore as the source of truth (matches MapContainer)
    const _date = persistantStore.selectedDate && persistantStore.selectedDate();
    // Include race/leg filters so map data refetches when filters change (FleetMap respects timeseries filters)
    const _races = (globalSelectedRaces && globalSelectedRaces()) || [];
    const _legs = (globalSelectedLegs && globalSelectedLegs()) || [];
    // Re-run when race options change (e.g. date/races loaded and set hour or race options) so we refetch with correct filter
    const _raceOptions = (raceOptions && raceOptions()) || [];
    const racesKey = Array.isArray(_races) ? _races.slice().sort().join(',') : '';
    const legsKey = Array.isArray(_legs) ? _legs.slice().sort().join(',') : '';
    const optionsKey = Array.isArray(_raceOptions) ? _raceOptions.slice().sort().join(',') : '';
    
    // Create a signature to detect actual changes
    const signature = `${_ids instanceof Set ? Array.from(_ids).sort().join(',') : ''}_${_date || ''}_${racesKey}_${legsKey}_${optionsKey}`;
    
    // Only fetch if signature changed (prevent infinite loops)
    if (signature !== lastFetchSignature) {
      lastFetchSignature = signature;
      fetchCount = 0;
      // Use setTimeout to ensure fetch is async and doesn't block effect execution
      setTimeout(() => {
        void fetchCombinedData();
      }, 0);
    } else {
      fetchCount++;
      if (fetchCount > MAX_FETCH_ATTEMPTS) {
        logWarn('MultiMapTimeSeries: Detected potential infinite loop, stopping fetches', {
          signature,
          fetchCount
        });
        return;
      }
    }
  });

  // Initialize/re-initialize SVG when data is available
  // Update scales when time/value extents change
  createEffect(() => {
    const [minTime, maxTime] = timeExtent();
    const [minVal, maxVal] = valueExtent();
    
    if (xScale && yScale && svg) {
      let scaleChanged = false;
      
      // Update scale domains
      if (minTime && maxTime && !isNaN(minTime.getTime()) && !isNaN(maxTime.getTime()) && minTime.getTime() !== maxTime.getTime()) {
        const oldDomain = xScale.domain();
        xScale.domain([minTime, maxTime]);
        const newDomain = xScale.domain();
        
        // Check if domain actually changed
        if (oldDomain.length !== newDomain.length || 
            oldDomain[0].getTime() !== newDomain[0].getTime() || 
            oldDomain[1].getTime() !== newDomain[1].getTime()) {
          scaleChanged = true;
        }
      }
      
      if (Number.isFinite(minVal) && Number.isFinite(maxVal) && minVal !== maxVal) {
        yScale.domain([minVal * 0.95, maxVal * 1.05]);
      }
      
      // Update axes smoothly (with transition in live mode)
      updateAxes();
      
      // Re-render when scale changes
      if (scaleChanged) {
        render();
      }
    }
  });

  // Effect: Initialize/re-render when data changes
  createEffect(() => {
    const groups = groupedData();
    
    if (groups.length > 0 && chartContainer) {
      const tryInit = () => {
        const bbox = chartContainer.getBoundingClientRect();
        if (bbox.width > 0 && bbox.height > 0) {
          if (!svg) initSVG();
          render();
        } else {
          requestAnimationFrame(tryInit);
        }
      };
      setTimeout(tryInit, 50);
    }
  });

  // Cleanup
  onCleanup(() => {
    window.removeEventListener('resize', handleResize);
    if (resizeObserver && chartContainer) {
      try { resizeObserver.unobserve(chartContainer); } catch (_) {}
      resizeObserver = null;
    }
  });

  // Re-render cursor when selectedTime changes
  createEffect(() => {
    const _time = selectedTime();
    if (_time && svg) {
      renderCursor();
    }
  });

  // Update path opacity/stroke when fleet map boat hover/selection changes (render() is not re-run on hover)
  createEffect(() => {
    const highlighted = props.highlightedSourceIds ?? new Set<number>();
    if (!svg) return;
    const hasHighlight = highlighted.size > 0;
    svg.selectAll("path.series-line")
      .style("stroke-width", (d: { sourceId: number }) => (hasHighlight && highlighted.has(d.sourceId)) ? "3px" : "1px")
      .style("opacity", (d: { sourceId: number }) => (hasHighlight && highlighted.has(d.sourceId)) ? 1 : (hasHighlight ? 0.3 : 1));
  });

  // Send filtered data to map whenever sources, races, or legs change
  // NOTE: MultiMapTimeSeries always sends the full timeline data (filtered only by source/race/leg)
  // Time window filtering is handled by MultiTrackLayer when rendering the map tracks
  createEffect(() => {
    const groups = groupedData(); // Track groupedData to trigger on source/race/leg changes
    const filteredData = getFilteredData(); // Get filtered data (by source/race/leg only, no time window)
    // Track data length to detect when data is refetched after source changes
    // This ensures map updates both when sources change AND when new data arrives
    const dataLength = combinedData().length;
    
    // Create a signature of current filters to detect actual changes
    const currentIds = getSelectedSourceIds();
    const races = Array.isArray(props.selectedRacesTimeseries) ? props.selectedRacesTimeseries : (Array.isArray(props.selectedRaces) ? props.selectedRaces : (globalSelectedRaces && globalSelectedRaces()));
    const legs = Array.isArray(props.selectedLegsTimeseries) ? props.selectedLegsTimeseries : (Array.isArray(props.selectedLegs) ? props.selectedLegs : (globalSelectedLegs && globalSelectedLegs()));
    const playing = isPlaying();
    const hasRange = Array.isArray(selectedRange()) && selectedRange().length > 0;
    // Filter signature includes source/race/leg filters AND data length (to detect refetches)
    const filterSignature = `${currentIds instanceof Set ? Array.from(currentIds).sort().join(',') : ''}_${Array.isArray(races) ? races.join(',') : ''}_${Array.isArray(legs) ? legs.join(',') : ''}_${hasRange}_${dataLength}`;
    
    // Don't send data if selectedSourceIds is empty AND we have no data yet (still initializing)
    // But if we have data and sources are empty, send all data (MultiTrackLayer will handle it)
    // NOTE: Historical data query happens ONLY in onMount, not in reactive effects
    if (currentIds instanceof Set && currentIds.size === 0 && dataLength === 0) {
      return;
    }
    
      // Only reset time and send data if filters actually changed (not just a re-run of the effect)
      // OR if data just became available (dataLength changed from 0 to >0)
      // This prevents unnecessary data sends when only timeWindow changes
      const filtersChanged = filterSignature !== lastFilterSignature;
      const dataJustLoaded = dataLength > 0 && lastFilterSignature === '';
      
      if (filtersChanged || dataJustLoaded) {
        lastFilterSignature = filterSignature;
        
        // Only reset time to start if there's no active brush selection AND not playing AND timeWindow === 0
        // When timeWindow > 0, we want to keep selectedTime where it is (don't reset to start)
        // When brushing or playing, those handlers control the time
        const currentTimeWindow = timeWindow();
        if (!hasRange && !playing && filteredData.length > 0 && currentTimeWindow === 0) {
          // Find the minimum time in the filtered data
          let minTime = Infinity;
          for (const d of filteredData) {
            const t = new Date(d.Datetime || d.timestamp || d.time).getTime();
            if (t < minTime) minTime = t;
          }
          
          if (Number.isFinite(minTime)) {
            const startTime = new Date(minTime);
            if (requestTimeControl('multimaptimeseries')) {
              setIsManualTimeChange(true);
              setSelectedTime(startTime, 'multimaptimeseries');
              if (onStableSelectedTimeChange) {
                onStableSelectedTimeChange(startTime);
              }
              setTimeout(() => {
                releaseTimeControl('multimaptimeseries');
              }, 100);
            }
          }
        }
        
        // Send data to map when filters change OR when data first loads (including [] when no sources selected)
        // Time window filtering is handled by MultiTrackLayer, so we don't need to send data when only timeWindow changes
        safeOnMapUpdate(filteredData);
        if (!isVideoContext() && filteredData.length > 0) {
          debug('MultiMapTimeSeries: Reactive effect sending data to map', {
            reason: dataJustLoaded ? 'initial data load' : 'filters changed',
            filteredDataLength: filteredData.length,
            filterSignature
          });
        }
      }
  });

  return (
    <div
      ref={(el) => (chartContainer = el)}
      class="chart maptimeseries-chart"
      style="width: 100%; height: 100%; background: var(--color-bg-card);"
    />
  );
}
