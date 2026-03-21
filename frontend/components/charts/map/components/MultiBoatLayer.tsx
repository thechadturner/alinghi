// @ts-nocheck
import { For, createMemo } from "solid-js";
import BoatLayer from "./BoatLayer";
import { sourcesStore } from "../../../../store/sourcesStore";
import { playbackSpeed, isPlaying } from "../../../../store/playbackStore";
import { selectedRanges, selectedRange } from "../../../../store/selectionStore";

export interface MultiBoatLayerProps {
  data: any[];
  map: any;
  mapContainer: HTMLElement;
  samplingFrequency: number;
  /** Set of enabled source IDs, or accessor so SolidJS memos re-run when selection changes */
  selectedSourceIds: Set<number> | (() => Set<number>);
  onBoatClick?: (p: any) => void;
  /** When animation is stopped, hovered source id for path highlight and label emphasis */
  hoveredSourceId?: number | null;
  onBoatHover?: (sourceId: number | null) => void;
  /** Source IDs to highlight (hovered + selected boats); label emphasis and path highlight */
  highlightedSourceIds?: Set<number>;
}

/** Resolve selectedSourceIds from prop (accessor or value) so memos track reactivity. */
function getSelectedSourceIds(props: MultiBoatLayerProps): Set<number> {
  const raw = props.selectedSourceIds;
  if (typeof raw === 'function') return raw() || new Set();
  return raw || new Set();
}

export default function MultiBoatLayer(props: MultiBoatLayerProps) {
  const sourceKey = (d: any) => d?.source_id ?? d?.Source_id ?? d?.sourceId ?? d?.sourceID;

  // Helper to get timestamp from data point
  const getTimestamp = (d: any): Date => {
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

  // Calculate average time interval between points for a dataset
  const calculateAverageInterval = (data: any[]): number | null => {
    if (!data || data.length < 2) return null;
    
    const intervals: number[] = [];
    for (let i = 1; i < data.length; i++) {
      const time1 = getTimestamp(data[i - 1]).getTime();
      const time2 = getTimestamp(data[i]).getTime();
      if (time1 > 0 && time2 > 0 && time2 > time1) {
        intervals.push(time2 - time1);
      }
    }
    
    if (intervals.length === 0) return null;
    
    const sum = intervals.reduce((a, b) => a + b, 0);
    return sum / intervals.length;
  };

  // Calculate transition duration based on playback speed and point intervals
  const calculateTransitionDuration = (data: any[]): number | undefined => {
    const speed = playbackSpeed();
    if (speed <= 0) return undefined;
    
    // Calculate average interval between points
    const avgInterval = calculateAverageInterval(data);
    if (!avgInterval) return undefined;
    
    // Transition duration = average interval * speed
    // This ensures the boat animates smoothly over N points (where N = speed)
    const duration = avgInterval * speed;
    
    // Clamp to reasonable bounds (50ms to 5 seconds)
    return Math.max(50, Math.min(5000, duration));
  };

  // Helper function to filter data by selected time ranges (brush selection)
  const filterDataBySelectedRanges = (data: any[]): any[] => {
    const ranges = selectedRanges();
    const singleRange = selectedRange();
    
    // Check if we have any range selection
    const activeRanges: Array<{ start_time: Date | string; end_time: Date | string }> = [];
    
    // Add selectedRanges (multiple ranges)
    if (Array.isArray(ranges) && ranges.length > 0) {
      activeRanges.push(...ranges);
    }
    
    // Add selectedRange (single range) if selectedRanges is empty
    if (activeRanges.length === 0 && Array.isArray(singleRange) && singleRange.length > 0) {
      activeRanges.push(...singleRange);
    }
    
    // If no ranges, return all data
    if (activeRanges.length === 0) {
      return data;
    }
    
    // Filter data to include only points within any of the selected ranges
    const filteredData = data.filter(d => {
      const timestamp = getTimestamp(d);
      const timestampMs = timestamp.getTime();
      
      // Check if point falls within any of the selected ranges
      return activeRanges.some(range => {
        const startTime = range.start_time instanceof Date 
          ? range.start_time.getTime() 
          : new Date(range.start_time).getTime();
        const endTime = range.end_time instanceof Date 
          ? range.end_time.getTime() 
          : new Date(range.end_time).getTime();
        
        return timestampMs >= startTime && timestampMs <= endTime;
      });
    });
    
    return filteredData;
  };

  // Show boat icons for all selected sources so every boat remains visible and clickable.
  // highlightedSourceIds is used only for visual emphasis (isHighlighted) per boat, not for filtering which boats are shown.
  const boatSourceIds = createMemo(() => getSelectedSourceIds(props));

  const grouped = createMemo(() => {
    // Track selectedRange and selectedRanges to ensure memo updates when brush selection changes
    const _selectedRange = selectedRange();
    const _selectedRanges = selectedRanges();
    const selected = getSelectedSourceIds(props);
    const forBoats = boatSourceIds();
    
    const groups = new Map<number, any[]>();
    let arr = Array.isArray(props.data) ? props.data : [];
    
    if (selected.size === 0 || forBoats.size === 0) {
      return [] as Array<[number, any[]]>;
    }
    
    // Only consider points from enabled sources so disabled sources never show boats
    arr = arr.filter((pt) => {
      const sid = Number(sourceKey(pt));
      return Number.isFinite(sid) && selected.has(sid);
    });
    
    // Apply brush selection filtering if active
    // Use the tracked values from the memo
    const ranges = _selectedRanges;
    const singleRange = _selectedRange;
    const hasBrushSelection = (Array.isArray(ranges) && ranges.length > 0) || 
                              (Array.isArray(singleRange) && singleRange.length > 0);
    
    if (hasBrushSelection) {
      arr = filterDataBySelectedRanges(arr);
    }
    
    for (const pt of arr) {
      const sid = Number(sourceKey(pt));
      if (!Number.isFinite(sid)) continue;
      if (!selected.has(sid)) continue;
      if (!forBoats.has(sid)) continue;
      if (!groups.has(sid)) groups.set(sid, []);
      groups.get(sid)!.push(pt);
    }
    
    // Sort each group by timestamp to ensure proper ordering
    const sortedGroups = new Map<number, any[]>();
    for (const [sid, data] of groups.entries()) {
      const sorted = [...data].sort((a, b) => {
        const aTime = getTimestamp(a).getTime();
        const bTime = getTimestamp(b).getTime();
        return aTime - bTime;
      });
      
      // When playing, filter out the last N points to match MultiTrackLayer behavior
      // This ensures the boat starts from the last drawn track point
      const speed = playbackSpeed();
      const isCurrentlyPlaying = isPlaying();
      if (isCurrentlyPlaying && speed > 0) {
        const pointsToSkip = Math.max(0, Math.floor(speed));
        if (pointsToSkip > 0 && sorted.length > pointsToSkip) {
          // Keep all points up to the last drawn point (same as MultiTrackLayer)
          // The boat will animate from this point to the current selectedTime
          sortedGroups.set(sid, sorted.slice(0, sorted.length - pointsToSkip));
        } else {
          sortedGroups.set(sid, sorted);
        }
      } else {
        sortedGroups.set(sid, sorted);
      }
    }
    
    return Array.from(sortedGroups.entries());
  });

  // Get full data for each source (for speed change positioning)
  // Note: This is "full" relative to the filtered data, but still respects brush selection
  const fullGroupedData = createMemo(() => {
    // Track selectedRange and selectedRanges to ensure memo updates when brush selection changes
    const _selectedRange = selectedRange();
    const _selectedRanges = selectedRanges();
    const selected = getSelectedSourceIds(props);
    
    const groups = new Map<number, any[]>();
    let arr = Array.isArray(props.data) ? props.data : [];
    
    if (selected.size === 0) {
      return new Map<number, any[]>();
    }
    
    // Only consider points from enabled sources
    arr = arr.filter((pt) => {
      const sid = Number(sourceKey(pt));
      return Number.isFinite(sid) && selected.has(sid);
    });
    
    // Apply brush selection filtering if active (same as grouped memo)
    // Use the tracked values from the memo
    const ranges = _selectedRanges;
    const singleRange = _selectedRange;
    const hasBrushSelection = (Array.isArray(ranges) && ranges.length > 0) || 
                              (Array.isArray(singleRange) && singleRange.length > 0);
    
    if (hasBrushSelection) {
      arr = filterDataBySelectedRanges(arr);
    }
    
    for (const pt of arr) {
      const sid = Number(sourceKey(pt));
      if (!Number.isFinite(sid)) continue;
      if (!selected.has(sid)) continue;
      if (!groups.has(sid)) groups.set(sid, []);
      groups.get(sid)!.push(pt);
    }
    
    // Sort each group by timestamp
    const sortedGroups = new Map<number, any[]>();
    for (const [sid, data] of groups.entries()) {
      const sorted = [...data].sort((a, b) => {
        const aTime = getTimestamp(a).getTime();
        const bTime = getTimestamp(b).getTime();
        return aTime - bTime;
      });
      sortedGroups.set(sid, sorted);
    }
    
    return sortedGroups;
  });

  return (
    <>
      <For each={grouped()}>{([sid, data]) => {
        const sources = sourcesStore.sources();
        const sourceInfo = sources.find((s: any) => Number(s.source_id) === Number(sid));
        const color = sourceInfo?.color || '#1f77b4';
        
        // Get full unfiltered data for this source (for speed change positioning)
        const fullData = fullGroupedData().get(sid) || data;
        
        // Calculate transition duration based on playback speed and point intervals
        // This ensures smooth animation from the last drawn point to the current position
        // Duration = average time between points * playback speed
        const transitionDuration = calculateTransitionDuration(data);
        
        return (
          <BoatLayer
            key={`boat-${sid}`}
            sourceId={sid}
            sourceName={sourceInfo?.source_name || ''}
            data={data}
            fullData={fullData}
            map={props.map}
            mapContainer={props.mapContainer}
            samplingFrequency={props.samplingFrequency}
            color={color}
            transitionDuration={transitionDuration}
            onBoatClick={props.onBoatClick}
            isHovered={props.hoveredSourceId != null && props.hoveredSourceId === sid}
            isHighlighted={(props.highlightedSourceIds ?? new Set()).has(sid)}
            onHover={props.onBoatHover ? () => props.onBoatHover!(sid) : undefined}
            onLeave={props.onBoatHover ? () => props.onBoatHover!(null) : undefined}
          />
        );
      }}</For>
    </>
  );
}


