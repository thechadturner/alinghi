// @ts-nocheck
import { createSignal, createEffect, onCleanup } from "solid-js";
import { selectedTime, setSelectedTime, requestTimeControl } from "../../../../store/playbackStore";
import { selectedRange, setSelectedRange, setHasSelection, setIsCut } from "../../../../store/selectionStore";

export interface DateRange {
  start: Date;
  end: Date;
}

export interface TrackPoint {
  Datetime: Date;
  Lat: number;
  Lng: number;
  Twd: number;
  Twa: number;
  Tws: number;
  Bsp: number;
  Hdg: number;
  Grade: number;
  Vmg_perc: number;
  event_id: number;
  [key: string]: any;
}

export function useMapInteractions() {
  const [selectedRange, setSelectedRangeState] = createSignal<DateRange | null>(null);
  const [isSelecting, setIsSelecting] = createSignal(false);
  const [selectionStart, setSelectionStart] = createSignal<TrackPoint | null>(null);
  const [selectionEnd, setSelectionEnd] = createSignal<TrackPoint | null>(null);

  // Helper function to get timestamp from data point
  const getTimestamp = (d: TrackPoint): Date => {
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

  // Start range selection on map track
  const startRangeSelection = (point: TrackPoint) => {
    setIsSelecting(true);
    setSelectionStart(point);
    setSelectionEnd(null);
  };

  // Update range selection as user drags
  const updateRangeSelection = (point: TrackPoint) => {
    if (isSelecting()) {
      setSelectionEnd(point);
    }
  };

  // Complete range selection
  const completeRangeSelection = () => {
    if (isSelecting() && selectionStart() && selectionEnd()) {
      const start = selectionStart()!;
      const end = selectionEnd()!;
      
      // Ensure start is before end
      const startTime = getTimestamp(start);
      const endTime = getTimestamp(end);
      
      if (startTime <= endTime) {
        const range: DateRange = { start: startTime, end: endTime };
        setSelectedRangeState(range);
        
        // Update global state
        setSelectedRange([{
          type: "range",
          start_time: startTime,
          end_time: endTime
        }]);
        setHasSelection(true);
        setIsCut(false);
      }
    }
    
    setIsSelecting(false);
    setSelectionStart(null);
    setSelectionEnd(null);
  };

  // Cancel range selection
  const cancelRangeSelection = () => {
    setIsSelecting(false);
    setSelectionStart(null);
    setSelectionEnd(null);
  };

  // Handle single point click (time selection)
  const handlePointClick = (point: TrackPoint) => {
    const time = getTimestamp(point);
    if (requestTimeControl('map')) {
      setSelectedTime(time, 'map');
    }
    
    // Clear any existing range selection
    setSelectedRangeState(null);
    setSelectedRange([]);
    setHasSelection(false);
  };

  // Clear all selections
  const clearSelections = () => {
    setSelectedRangeState(null);
    setSelectedRange([]);
    setHasSelection(false);
    setIsCut(false);
  };

  // Get current selection bounds for rendering
  const getSelectionBounds = (): { start: TrackPoint | null; end: TrackPoint | null } => {
    return {
      start: selectionStart(),
      end: selectionEnd()
    };
  };

  onCleanup(() => {
    // Clean up any ongoing selections
    if (isSelecting()) {
      cancelRangeSelection();
    }
  });

  return {
    selectedRange: selectedRange,
    isSelecting: isSelecting,
    selectionStart: selectionStart,
    selectionEnd: selectionEnd,
    startRangeSelection,
    updateRangeSelection,
    completeRangeSelection,
    cancelRangeSelection,
    handlePointClick,
    clearSelections,
    getSelectionBounds
  };
}
