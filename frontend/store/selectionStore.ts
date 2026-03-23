/**
 * SelectionStore: Manages data selection, ranges, and events
 * 
 * This store handles:
 * - User selections (brush selections, cut events)
 * - Time ranges and event selections
 * - Cross-window synchronization for selections (NOT filters - see filterStore)
 * 
 * Note: For filter-related functions, import from './filterStore' instead.
 * 
 * @module selectionStore
 */

import { createSyncSignal, clearSyncData } from '@solidjs/sync';
import { createSignal, onCleanup, createEffect, createRoot, untrack, batch } from 'solid-js';
import { warn, error as logError, debug, log } from '../utils/console';
import { persistantStore } from './persistantStore';

// Helper function to check if it's safe to call sync functions
// BroadcastChannel might be closed during page unload or in certain browser states
const isSafeToSync = (): boolean => {
  if (typeof document === 'undefined') return false;
  // Check if page is unloading or document is not active
  if (document.visibilityState === 'hidden' || 
      document.readyState === 'loading') {
    return false;
  }
  return true;
};
import { clearAllFilters } from './filterStore';
import { groupDisplayMode } from './globalStore';

// Global type declaration for cross-window API
declare global {
  interface Window {
    clearMapBrush?: () => void;
    clearTimeSeriesBrush?: () => void;
  }
}

// Global broadcast function for cross-window synchronization (selection only, not filters)
let isUpdatingFromCrossWindow = false;

// Guard flag to prevent recursive calls to setSelectedEvents
let isUpdatingSelectedEvents = false;

// When setSelectedRange([range]) is called (brush selection), we then call setSelectedEvents([]).
// The runFollowUp from that runs in a microtask and must not clear selectedRange/hasSelection.
// In split view with map in the other panel, sync or effect order can make selectedRange() read empty in the microtask.
// This flag forces runFollowUp to skip the clear when the brush handler just set a range.
let brushSelectionJustSet = false;

// Store cleanup function for manual disposal
let cleanupFunction: (() => void) | null = null;

// Cross-window synchronization setup (selection only - filters are handled by filterStore)
if (typeof window !== 'undefined') {
  const handleCrossWindowUpdate = (event: CustomEvent) => {
    const payload = event.detail;
    
    if (payload.type === 'SELECTION_CHANGE') {
      // Set flag to prevent broadcasting back to other windows
      // Use setTimeout to ensure flag remains set during any reactive effects
      isUpdatingFromCrossWindow = true;
      
      // Update selection data only (no filter data)
      if (payload.selection !== undefined) setSelectionState(payload.selection);
      // In split view, don't let incoming sync overwrite a local brush selection (stops banner flashing when map is the other panel)
      const inSplitView = typeof document !== 'undefined' && document.querySelector('.split-view-content') != null;
      const incomingRangeEmpty = payload.selectedRange !== undefined && (!Array.isArray(payload.selectedRange) || payload.selectedRange.length === 0);
      const currentRange = selectedRangeState();
      const haveLocalBrush = Array.isArray(currentRange) && currentRange.length > 0;
      const preserveLocalBrush = inSplitView && incomingRangeEmpty && haveLocalBrush;
      if (payload.hasSelection !== undefined && !preserveLocalBrush) setHasSelectionState(payload.hasSelection);
      if (payload.isCut !== undefined) setIsCutState(payload.isCut);
      if (payload.selectedEvents !== undefined) {
        // Normalize selectedEvents to numbers (handle both old object format and new number format)
        const events = Array.isArray(payload.selectedEvents) 
          ? payload.selectedEvents.map((e: unknown) => {
              if (typeof e === 'number') return e;
              if (typeof e === 'object' && e !== null && 'event_id' in e) return (e as { event_id: number }).event_id;
              return null;
            }).filter((e: number | null): e is number => e !== null && typeof e === 'number' && !isNaN(e))
          : [];
        setSelectedEventsState(events);
      }
      if (payload.selectedRange !== undefined) {
        if (preserveLocalBrush) {
          // Keep local brush selection; ignore incoming clear
        } else {
          setSelectedRangeState(payload.selectedRange);
        }
      }
      if (payload.selectedRanges !== undefined) setSelectedRangesState(payload.selectedRanges);
      if (payload.cutEvents !== undefined) {
        // Skip no-op: avoid re-setting cutEvents to [] when already [] to prevent endless
        // loops in maneuver window (each set triggers effect → applyFilters → updateTimeSeries → sync → set again)
        const current = cutEventsState();
        const newVal = Array.isArray(payload.cutEvents) ? payload.cutEvents : [];
        const bothEmpty = newVal.length === 0 && (!current || current.length === 0);
        if (!bothEmpty) {
          // Use setCutEvents (not setCutEventsState) to ensure validation is applied
          setCutEvents(payload.cutEvents);
        }
      }
      if (payload.selectedGroupKeys !== undefined) {
        setSelectedGroupKeysState(payload.selectedGroupKeys);
      }

      // Reset flag after a microtask to ensure reactive effects have completed
      // This prevents async effects from triggering broadcasts
      Promise.resolve().then(() => {
        isUpdatingFromCrossWindow = false;
      });
    }
  };

  // Add event listener for cross-window updates
  window.addEventListener('selectionStoreUpdate', handleCrossWindowUpdate as EventListener);
  
  // Create cleanup function
  cleanupFunction = () => {
    window.removeEventListener('selectionStoreUpdate', handleCrossWindowUpdate as EventListener);
  };
}

// Type definitions
export interface SelectionData {
  [key: string]: any;
}

export interface EventData {
  start_time?: string;
  end_time?: string;
  [key: string]: any;
}

export interface FilterData {
  [key: string]: any;
}

export type SyncFunction = () => void;

// Declare all signal variables first
let isSelectionLoadingState: any;
let setIsSelectionLoadingState: any;
let _syncIsSelectionLoading: any;
let hasSelectionState: any;
let setHasSelectionState: any;
let _syncHasSelection: any;
let allowTimeWindowState: any;
let setAllowTimeWindowState: any;
let _syncAllowTimeWindow: any;
let isCutState: any;
let setIsCutState: any;
let _syncIsCut: any;
let selectionState: any;
let setSelectionState: any;
let _syncSelection: any;
let cutEventsState: any;
let setCutEventsState: any;
let _syncCutEvents: any;
let selectedRangeState: any;
let setSelectedRangeState: any;
let _syncSelectedRange: any;
let selectedEventsState: any;
let setSelectedEventsState: any;
let _syncSelectedEvents: any;
let selectedRangesState: any;
let setSelectedRangesState: any;
let _syncSelectedRanges: any;
let selectedGroupKeysState: any;
let setSelectedGroupKeysState: any;
let _syncSelectedGroupKeys: any;

// Initialize all signals within a createRoot to avoid cleanup warnings
// Create an effect inside createRoot to ensure reactive context is active when createSyncSignal registers cleanups
createRoot(() => {
  // Create a dummy effect to establish reactive context
  createEffect(() => {
    // This effect ensures the reactive context is active
    // when createSyncSignal registers its internal cleanups
  });
  
  [isSelectionLoadingState, setIsSelectionLoadingState, _syncIsSelectionLoading] = createSyncSignal(false, { 
    key: "isSelectionLoading",
    autoSync: true 
  });
  [hasSelectionState, setHasSelectionState, _syncHasSelection] = createSyncSignal(false, {
    key: "hasSelection",
    autoSync: true
  });
  [allowTimeWindowState, setAllowTimeWindowState, _syncAllowTimeWindow] = createSyncSignal(true, {
    key: "allowTimeWindow",
    autoSync: true
  });
  [isCutState, setIsCutState, _syncIsCut] = createSyncSignal(false, {
    key: "isCut",
    autoSync: true
  });
  [selectionState, setSelectionState, _syncSelection] = createSyncSignal([], {
    key: "selection", 
    autoSync: true
  });
  [cutEventsState, setCutEventsState, _syncCutEvents] = createSyncSignal([], {
    key: "cutEvents", 
    autoSync: true
  });
  [selectedRangeState, setSelectedRangeState, _syncSelectedRange] = createSyncSignal([], {
    key: "selectedRange", 
    autoSync: true
  });
  [selectedEventsState, setSelectedEventsState, _syncSelectedEvents] = createSyncSignal<number[]>([], {
    key: "selectedEvents",
    autoSync: true
  });
  [selectedRangesState, setSelectedRangesState, _syncSelectedRanges] = createSyncSignal([], {
    key: "selectedRanges",
    autoSync: true
  });
  [selectedGroupKeysState, setSelectedGroupKeysState, _syncSelectedGroupKeys] = createSyncSignal<(string | number)[]>([], {
    key: "selectedGroupKeys",
    autoSync: true
  });
});

// Local-only state: hidden event IDs (not synced, cleared on reload)
const [hiddenEventsState, setHiddenEventsState] = createSignal<number[]>([]);

//SELECTION
export const isSelectionLoading = () => isSelectionLoadingState(); 
export const setIsSelectionLoading = (value: boolean) => {
  try {
    setIsSelectionLoadingState(value);
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[SelectionStore] setIsSelectionLoading skipped - BroadcastChannel is closed`);
    } else {
      warn(`[SelectionStore] Error in setIsSelectionLoading:`, error);
    }
  }
};

export const hasSelection = () => Boolean(hasSelectionState()); 
export const setHasSelection = (value: boolean) => {
  try {
    setHasSelectionState(Boolean(value));
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[SelectionStore] setHasSelection skipped - BroadcastChannel is closed`);
    } else {
      warn(`[SelectionStore] Error in setHasSelection:`, error);
    }
  }
  
  // If a new selection is made, remove the selectionCleared flag
  if (value && typeof window !== 'undefined' && window.sessionStorage) {
    sessionStorage.removeItem('selectionCleared');
  }
  
  // Broadcast selection update to other windows
  try {
    if (typeof window !== 'undefined' && !isUpdatingFromCrossWindow && window.opener && !window.opener.closed) {
      window.opener.postMessage({
        type: 'SELECTION_UPDATE_FROM_CHILD',
        payload: {
          type: 'SELECTION_CHANGE',
          hasSelection: Boolean(value)
        },
        windowName: window.name
      }, window.location.origin);
    }
  } catch (error) {
    // Ignore cross-window communication errors
  }
};

export const allowTimeWindow = () => Boolean(allowTimeWindowState());
export const setAllowTimeWindow = (value: boolean) => {
  try {
    setAllowTimeWindowState(Boolean(value));
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[SelectionStore] setAllowTimeWindow skipped - BroadcastChannel is closed`);
    } else {
      warn(`[SelectionStore] Error in setAllowTimeWindow:`, error);
    }
  }
};

export const isCut = () => Boolean(isCutState()); 
export const setIsCut = (value: boolean) => {
  try {
    setIsCutState(Boolean(value));
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[SelectionStore] setIsCut skipped - BroadcastChannel is closed`);
    } else {
      warn(`[SelectionStore] Error in setIsCut:`, error);
    }
  }
};

// Add logging for all array type accessors
export const selection = () => {
  try {
    const sel = selectionState();
    
    return Array.isArray(sel) ? sel : [];
  } catch (error) {
    logError("Error accessing selection:", error);
    return [];
  }
};
export const setSelection = (value: SelectionData[]) => {
  try {
    setSelectionState(value);
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[SelectionStore] setSelection skipped - BroadcastChannel is closed`);
    } else {
      warn(`[SelectionStore] Error in setSelection:`, error);
    }
  }
};

export const cutEvents = () => {
  try {
    const events = cutEventsState();
    return Array.isArray(events) ? events : [];
  } catch (error) {
    logError("Error accessing cutEvents:", error);
    return [];
  }
};

export const setCutEvents = (value: (EventData | number)[]) => {
  try {
    // Validate and filter cutEvents to ensure we only store valid event data
    // cutEvents should contain:
    // - Event IDs (numbers)
    // - Event objects with event_id (and optionally start_time/end_time with type: 'event')
    // cutEvents should NOT contain:
    // - Range objects with type: 'range' (these belong in selectedRange, not cutEvents)
    // - Dataset time ranges (very large ranges > 24 hours)
    
    let filteredValue: (EventData | number)[] = [];
    
    if (Array.isArray(value)) {
      filteredValue = value.filter((item) => {
        // Accept numbers (event IDs)
        if (typeof item === 'number') {
          return true;
        }
        
        // Reject objects with type: 'range' - these belong in selectedRange, not cutEvents
        if (item && typeof item === 'object' && 'type' in item && item.type === 'range') {
          warn(`[SelectionStore] setCutEvents: Rejecting invalid item with type: 'range'. This looks like a selectedRange that was incorrectly passed to setCutEvents.`, {
            item: item,
            stack: new Error().stack
          });
          return false;
        }
        
        // Accept event objects (with event_id, or with start_time/end_time and type: 'event')
        if (item && typeof item === 'object') {
          // Check if it's a suspiciously large time range (might be a dataset time range)
          if ('start_time' in item && 'end_time' in item) {
            try {
              const startTime = new Date(item.start_time as string).getTime();
              const endTime = new Date(item.end_time as string).getTime();
              const rangeDuration = endTime - startTime;
              
              // Reject very large ranges (> 24 hours) - these are likely dataset time ranges
              if (rangeDuration > 24 * 60 * 60 * 1000) {
                warn(`[SelectionStore] setCutEvents: Rejecting suspiciously large time range (${rangeDuration / (60 * 60 * 1000)} hours). This might be a dataset time range being incorrectly set as cutEvents.`, {
                  start_time: item.start_time,
                  end_time: item.end_time,
                  duration_hours: rangeDuration / (60 * 60 * 1000),
                  stack: new Error().stack
                });
                return false;
              }
            } catch (dateError) {
              // Invalid date format - reject it
              warn(`[SelectionStore] setCutEvents: Rejecting item with invalid date format:`, {
                item: item,
                error: dateError,
                stack: new Error().stack
              });
              return false;
            }
          }
          
          // Accept valid event objects
          return true;
        }
        
        // Reject everything else
        warn(`[SelectionStore] setCutEvents: Rejecting invalid item:`, {
          item: item,
          itemType: typeof item,
          stack: new Error().stack
        });
        return false;
      });
      
      // Log if any items were filtered out
      if (filteredValue.length !== value.length) {
        warn(`[SelectionStore] setCutEvents: Filtered out ${value.length - filteredValue.length} invalid items from ${value.length} total items`, {
          originalCount: value.length,
          filteredCount: filteredValue.length,
          originalValue: value,
          filteredValue: filteredValue,
          stack: new Error().stack
        });
      }
    }
    
    // Skip no-op: avoid re-setting to [] when already [] (reduces log noise and prevents reactive cascades)
    const current = cutEventsState();
    const currentEmpty = !current || current.length === 0;
    const newEmpty = filteredValue.length === 0;
    if (currentEmpty && newEmpty) {
      return;
    }
    
    if (filteredValue.length > 0) {
      debug(`[SelectionStore] setCutEvents called with ${value?.length ?? 0} items (${filteredValue.length} valid after filtering)`, {
        originalValue: value,
        filteredValue: filteredValue,
        stack: new Error().stack
      });
    }
    setCutEventsState(filteredValue);
    
    // Broadcast cut events update to other windows for cross-window sync
    try {
      if (typeof window !== 'undefined' && !isUpdatingFromCrossWindow && window.opener && !window.opener.closed) {
        log('🧹 SelectionStore: Broadcasting cutEvents update to parent window', {
          cutEventsCount: filteredValue.length,
          isCut: filteredValue.length > 0
        });
        window.opener.postMessage({
          type: 'SELECTION_UPDATE_FROM_CHILD',
          payload: {
            type: 'SELECTION_CHANGE',
            cutEvents: filteredValue,
            isCut: filteredValue.length > 0
          },
          windowName: window.name
        }, window.location.origin);
      }
    } catch (error) {
      logError('🧹 SelectionStore: Error broadcasting cutEvents update:', error);
    }
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[SelectionStore] setCutEvents skipped - BroadcastChannel is closed`);
    } else {
      warn(`[SelectionStore] Error in setCutEvents:`, error);
    }
  }
};

// Add a watcher to detect when cutEventsState changes unexpectedly (e.g., from IndexedDB restore)
// This helps identify when dataset time ranges are incorrectly restored as cutEvents
// Note: This must be placed after setCutEvents is defined to avoid initialization errors
createRoot(() => {
  createEffect(() => {
    const currentCutEvents = cutEventsState();
    
    // Only log if cutEvents actually has data (not empty array)
    if (Array.isArray(currentCutEvents) && currentCutEvents.length > 0) {
      // Check if ANY item has type: 'range' - this is invalid and should be cleared immediately
      const hasInvalidRangeType = currentCutEvents.some(item => 
        item && typeof item === 'object' && 'type' in item && item.type === 'range'
      );
      
      if (hasInvalidRangeType) {
        const invalidItems = currentCutEvents.filter(item => 
          item && typeof item === 'object' && 'type' in item && item.type === 'range'
        );
        log(`[SelectionStore] cutEventsState changed to invalid range objects (type: 'range'). These should be in selectedRange, not cutEvents. Clearing them immediately.`, {
          cutEvents: currentCutEvents,
          cutEventsLength: currentCutEvents.length,
          invalidItems: invalidItems
        });
        // Clear invalid cutEvents immediately from both state and IndexedDB
        try {
          clearSyncData("cutEvents");
          clearSyncData("isCut");
        } catch (error) {
          warn("Error clearing invalid cutEvents from IndexedDB:", error);
        }
        setCutEvents([]);
        setIsCut(false);
        return;
      }
      
      // Check if ANY time range is suspiciously large (might be a dataset time range)
      const hasLargeRange = currentCutEvents.some(item => {
        if (item && typeof item === 'object' && 'start_time' in item && 'end_time' in item) {
          try {
            const startTime = new Date(item.start_time as string).getTime();
            const endTime = new Date(item.end_time as string).getTime();
            const rangeDuration = endTime - startTime;
            return rangeDuration > 24 * 60 * 60 * 1000; // More than 24 hours
          } catch {
            return true; // Invalid date - consider it suspicious
          }
        }
        return false;
      });
      
      if (hasLargeRange) {
        const largeRanges = currentCutEvents.filter(item => {
          if (item && typeof item === 'object' && 'start_time' in item && 'end_time' in item) {
            try {
              const startTime = new Date(item.start_time as string).getTime();
              const endTime = new Date(item.end_time as string).getTime();
              const rangeDuration = endTime - startTime;
              return rangeDuration > 24 * 60 * 60 * 1000;
            } catch {
              return true;
            }
          }
          return false;
        });
        
        warn(`[SelectionStore] cutEventsState changed to suspiciously large time range(s). This might be a dataset time range being incorrectly restored from IndexedDB. Clearing them immediately.`, {
          largeRanges: largeRanges,
          cutEventsLength: currentCutEvents.length
        });
        // Clear invalid cutEvents immediately from both state and IndexedDB
        try {
          clearSyncData("cutEvents");
          clearSyncData("isCut");
        } catch (error) {
          warn("Error clearing invalid cutEvents from IndexedDB:", error);
        }
        setCutEvents([]);
        setIsCut(false);
        return;
      }
      
      const firstItem = currentCutEvents[0];
      
      // Check if this looks like it might be a dataset time range
      if (firstItem && typeof firstItem === 'object' && 'start_time' in firstItem && 'end_time' in firstItem) {
        // Always log when cutEventsState changes (for debugging)
        debug(`[SelectionStore] cutEventsState changed to ${currentCutEvents.length} items`, {
          firstItem: firstItem,
          allItems: currentCutEvents,
          stack: new Error().stack
        });
      } else if (typeof firstItem === 'number') {
        // Event IDs - log for debugging
        debug(`[SelectionStore] cutEventsState changed to ${currentCutEvents.length} event IDs`, {
          eventIds: currentCutEvents,
          stack: new Error().stack
        });
      }
    }
  });
});

export const selectedRange = () => {
  try {
    // Make sure to call the function to get the value
    const range = selectedRangeState();
    
    return Array.isArray(range) ? range : [];
  } catch (error) {
    logError("Error accessing selectedRange:", error);
    return [];
  }
};

export const setSelectedRange = (value: EventData[]) => {
  log('🧹 SelectionStore: setSelectedRange called', {
    value: value?.length || 0,
    isUpdatingFromCrossWindow,
    hasOpener: !!(typeof window !== 'undefined' && window.opener),
    openerClosed: !!(typeof window !== 'undefined' && window.opener && window.opener.closed)
  });
  
  // Check if it's safe to call sync functions before calling
  // This prevents BroadcastChannel errors when the channel is closed
  if (isSafeToSync()) {
    try {
      setSelectedRangeState(value);
    } catch (error: any) {
      // BroadcastChannel might be closed (e.g., during page unload or tab close)
      if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
        debug(`[SelectionStore] setSelectedRange skipped - BroadcastChannel is closed`);
      } else {
        warn(`[SelectionStore] Error in setSelectedRange:`, error);
      }
      // Still continue with the rest of the function logic even if sync fails
    }
  } else {
    // Skip sync if page is unloading or document is not active
    // The state will still be updated locally, but won't sync across windows
    debug(`[SelectionStore] setSelectedRange skipped - page unloading or document not active`);
  }
  
  // When brush selection is made, clear event-based selections
  // Note: We do NOT set selectedRanges here - brush selections should remain separate from event selections
  // SelectionBanner already handles both selectedRanges and selectedRange, so no need to copy
  if (!isUpdatingFromCrossWindow) {
    if (value && value.length > 0) {
      // Brush selection made - clear event-based selections but keep selectedRanges separate.
      // Set flag so runFollowUp (from setSelectedEvents) does not clear selectedRange/hasSelection
      // when it runs in a microtask (avoids race in split view when map is the other panel).
      brushSelectionJustSet = true;
      setSelectedEvents([]); // Clear event-based selections
      log('🧹 SelectionStore: Brush selection made - cleared selectedEvents, keeping selectedRanges separate');
    } else if (selectedRanges().length === 0) {
      // Only clear selectedRanges if it's empty
      // This prevents clearing selectedRanges when setSelectedRange([]) is called from setSelectedEvents
      // No action needed - already empty
    }
  }
  
  // Broadcast selection update to other windows
  try {
    if (typeof window !== 'undefined' && !isUpdatingFromCrossWindow && window.opener && !window.opener.closed) {
      log('🧹 SelectionStore: Broadcasting selectedRange update to parent window');
      window.opener.postMessage({
        type: 'SELECTION_UPDATE_FROM_CHILD',
        payload: {
          type: 'SELECTION_CHANGE',
          selectedRange: value,
          hasSelection: value && value.length > 0
        },
        windowName: window.name
      }, window.location.origin);
    } else {
      log('🧹 SelectionStore: Not broadcasting selectedRange update', {
        hasWindow: typeof window !== 'undefined',
        isUpdatingFromCrossWindow,
        hasOpener: !!(typeof window !== 'undefined' && window.opener),
        openerClosed: !!(typeof window !== 'undefined' && window.opener && window.opener.closed)
      });
    }
  } catch (error) {
    logError('🧹 SelectionStore: Error broadcasting selectedRange update:', error);
  }
};

// Note: All filter-related functions are now in filterStore
// If you need filter functions, import from './filterStore' not './selectionStore'

export const selectedEvents = (): number[] => {
  try {
    const events = selectedEventsState();
    // Ensure we return an array of numbers, filtering out any invalid values
    const result = Array.isArray(events) 
      ? events.filter((e): e is number => typeof e === 'number' && !isNaN(e))
      : [];
    return result;
  } catch (error) {
    logError("Error accessing selectedEvents:", error);
    return [];
  }
};
export interface SetSelectedEventsOptions {
  /** When false, write state synchronously (e.g. from clearSelection in setTimeout). When true (default), defer write to setTimeout(0) so Solid's runUpdates/completeUpdates get a fresh stack. */
  defer?: boolean;
}

export const setSelectedEvents = (value: number[] | ((prev: number[]) => number[]), options?: SetSelectedEventsOptions): void => {
  const deferWrite = options?.defer !== false;
  
  // Guard against recursive calls - if already updating, return early
  if (isUpdatingSelectedEvents) {
    debug(`[SelectionStore] setSelectedEvents: Recursive call detected, skipping to prevent infinite loop`);
    return;
  }
  
  // Set guard flag to prevent recursive calls
  isUpdatingSelectedEvents = true;
  
  // Helper function to reset the flag
  const resetFlag = () => {
    isUpdatingSelectedEvents = false;
  };
  
  // Get previous selectedEvents to detect newly added events
  // Use untrack to prevent infinite loops if this function is called from a reactive effect
  let cleanValue: number[];
  let lastNewlyAddedEventId: number | null;
  try {
    const previousEvents = untrack(() => selectedEvents());
    
    // Normalize to ensure we always store numbers
    const normalizedValue: number[] = typeof value === 'function' 
      ? value(previousEvents)
      : value;
    
    // Ensure all values are numbers
    cleanValue = Array.isArray(normalizedValue)
      ? normalizedValue.filter((e): e is number => typeof e === 'number' && !isNaN(e))
      : [];
    
    // Find newly added events (events in cleanValue but not in previousEvents)
    const previousSet = new Set(previousEvents);
    const newlyAddedEvents = cleanValue.filter(eventId => !previousSet.has(eventId));
    lastNewlyAddedEventId = newlyAddedEvents.length > 0 ? newlyAddedEvents[newlyAddedEvents.length - 1] : null;
  } catch (error: any) {
    resetFlag();
    warn(`[SelectionStore] Error in setSelectedEvents:`, error);
    return;
  }
  
  const doWrite = () => {
    try {
      batch(() => {
        setSelectedEventsState(cleanValue);
      });
    } catch (error: any) {
      if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
        debug(`[SelectionStore] setSelectedEvents skipped - BroadcastChannel is closed`);
      } else {
        warn(`[SelectionStore] Error in setSelectedEvents:`, error);
      }
    }
  };
  
  const runFollowUp = () => {
    if (!isUpdatingFromCrossWindow) {
      Promise.resolve().then(() => {
      // If no events selected, clear selectedRanges immediately
      // BUT: Don't clear if selectedRange has a value (brush selection is active) or if brush just set it (split-view race).
      if (cleanValue.length === 0) {
        const skipClearBecauseBrushJustSet = brushSelectionJustSet;
        if (brushSelectionJustSet) brushSelectionJustSet = false;
        const currentSelectedRange = selectedRange();
        const hasBrushRange = currentSelectedRange && currentSelectedRange.length > 0;
        if (!skipClearBecauseBrushJustSet && !hasBrushRange) {
          log('🧹 SelectionStore: No events selected and no brush selection, clearing selectedRanges');
          batch(() => {
            setSelectedRanges([]);
            setSelectedRange([]);
            setHasSelection(false);
          });
        } else {
          if (skipClearBecauseBrushJustSet) {
            log('🧹 SelectionStore: No events selected but brush selection just set - preserving selectedRange (split view)');
          } else {
            log('🧹 SelectionStore: No events selected but brush selection is active, preserving selectedRanges');
          }
        }
        resetFlag();
        return;
      }
      
      // When events are selected, fetch their time ranges and populate selectedRanges
      // Also load events to HuniDB if cache is empty
      // Import unifiedDataStore dynamically to avoid circular dependency
      import('../store/unifiedDataStore.js').then(async ({ unifiedDataStore }) => {
        // Check if we're on a FleetPerformance or FleetPerformanceHistory page
        // These pages don't need time ranges - they work with event IDs directly
        const currentPath = typeof window !== 'undefined' ? window.location.pathname : '';
        const isFleetPerformancePage = currentPath.includes('FleetPerformance') || currentPath.includes('FleetPerformanceHistory');
        
        // Get class_name, project_id, and dataset_id from persistent store
        const className = persistantStore.selectedClassName?.();
        const projectId = persistantStore.selectedProjectId?.();
        const datasetId = persistantStore.selectedDatasetId?.();
        
        // FleetPerformance pages don't need time ranges - skip fetching
        // Also skip if datasetId is 0 (project-level data, not dataset-level)
        if (isFleetPerformancePage || (datasetId !== undefined && datasetId === 0)) {
          // FleetPerformance pages don't need time ranges - skip fetching
          // Just update hasSelection based on whether events are selected
          setHasSelection(cleanValue.length > 0);
          debug('🧹 SelectionStore: Skipping time range fetch for FleetPerformance page or datasetId=0 - not needed', {
            isFleetPerformancePage,
            datasetId
          });
          resetFlag();
          return;
        }
        
        // Ensure events are loaded into HuniDB before fetching time ranges
        if (className && projectId && datasetId) {
          try {
            // Check if events are already loaded in HuniDB for this specific dataset
            // Use huniDBStore directly to query by dataset_id and project_id
            const { huniDBStore } = await import('../store/huniDBStore.js');
            const { getData } = await import('../utils/global.js');
            const { apiEndpoints } = await import('../config/env.js');
            
            let shouldRefetchEvents = false;
            
            // Check if dataset was modified after events were cached
            try {
              const datasetInfoResponse = await getData(
                `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`
              );
              
              if (datasetInfoResponse?.success && datasetInfoResponse?.data?.date_modified) {
                const serverDateModified = new Date(datasetInfoResponse.data.date_modified).getTime();
                
                // Check cached date_modified in meta.datasets
                const cachedMetadata = await huniDBStore.getCachedDatasets(className);
                const datasetMetadata = cachedMetadata.find(d => String(d.dataset_id) === String(datasetId));
                
                if (datasetMetadata?.dateModified || datasetMetadata?.date_modified) {
                  const cachedDateModified = datasetMetadata.dateModified || datasetMetadata.date_modified || 0;
                  if (serverDateModified > cachedDateModified) {
                    log('🧹 SelectionStore: Dataset', datasetId, 'was modified on server after cache - events need refresh', {
                      serverDate: new Date(serverDateModified).toISOString(),
                      cachedDate: new Date(cachedDateModified).toISOString()
                    });
                    shouldRefetchEvents = true;
                  }
                } else {
                  // No cached date_modified - might be a new dataset or cache is incomplete
                  log('🧹 SelectionStore: No cached date_modified for dataset', datasetId, '- will check if events exist');
                }
              }
            } catch (err) {
              debug('🧹 SelectionStore: Could not check dataset modified_date:', err);
              // Continue with normal event check
            }
            
            const cachedEvents = await huniDBStore.queryEvents(className, {
              datasetId: String(datasetId),
              projectId: String(projectId)
            });
            
            if (!cachedEvents || cachedEvents.length === 0 || shouldRefetchEvents) {
              log('🧹 SelectionStore: Events not in HuniDB or dataset was updated for dataset', datasetId, '- fetching from API');
              // Events not loaded yet or dataset was updated - fetch and store them
              await unifiedDataStore.fetchEvents(className, projectId, datasetId);
              log('🧹 SelectionStore: Events loaded into HuniDB for dataset', datasetId);
            } else {
              log('🧹 SelectionStore: Events already in HuniDB for dataset', datasetId, '-', cachedEvents.length, 'events');
            }
          } catch (err) {
            logError('🧹 SelectionStore: Error ensuring events are loaded:', err);
            // Continue anyway - try to fetch time ranges even if loading failed
          }
        } else {
          warn('🧹 SelectionStore: Cannot ensure events are loaded - missing className, projectId, or datasetId', {
            className,
            projectId,
            datasetId
          });
        }
        
        // Fetch event time ranges in batch
        log('🧹 SelectionStore: Fetching time ranges for event IDs:', cleanValue, {
          className,
          projectId,
          datasetId
        });
        unifiedDataStore.getEventTimeRanges(cleanValue).then((timeRangesMap) => {
          log('🧹 SelectionStore: Received time ranges map:', {
            mapSize: timeRangesMap.size,
            eventIds: Array.from(timeRangesMap.keys()),
            ranges: Array.from(timeRangesMap.entries()).map(([id, range]) => ({
              eventId: id,
              starttime: range.starttime,
              endtime: range.endtime
            }))
          });
          
          const ranges = Array.from(timeRangesMap.entries()).map(([eventId, range]) => ({
            event_id: eventId,
            start_time: range.starttime,
            end_time: range.endtime,
            type: 'event'
          }));
          
          log('🧹 SelectionStore: Converted ranges:', ranges);
          
          // Always update selectedRanges, even if empty (to clear previous selections)
          log('🧹 SelectionStore: About to call setSelectedRanges with', ranges.length, 'ranges');
          setSelectedRanges(ranges);
          setSelectedRange([]); // Clear single range when using multiple ranges
          log('🧹 SelectionStore: Fetched and populated selectedRanges from selected events', ranges);
          log('🧹 SelectionStore: selectedRanges() now returns:', selectedRanges());
          
          // Update hasSelection based on whether we have any ranges
          setHasSelection(ranges.length > 0);
          
          // Warn if no ranges were found for selected events
          // Don't warn for FleetPerformance pages - they don't need time ranges
          const currentPathForWarning = typeof window !== 'undefined' ? window.location.pathname : '';
          const isFleetPerformancePageForWarning = currentPathForWarning.includes('FleetPerformance') || currentPathForWarning.includes('FleetPerformanceHistory');
          
          if (ranges.length === 0 && cleanValue.length > 0 && !isFleetPerformancePageForWarning && datasetId !== 0) {
            warn('🧹 SelectionStore: No time ranges found for selected events!', {
              selectedEventIds: cleanValue,
              className,
              projectId,
              datasetId
            });
          }
          
          // If a new event was added, set selectedTime to its start time
          if (lastNewlyAddedEventId !== null && ranges.length > 0) {
            const lastEventRange = timeRangesMap.get(lastNewlyAddedEventId);
            if (lastEventRange && lastEventRange.starttime) {
              try {
                const startTime = new Date(lastEventRange.starttime);
                if (!isNaN(startTime.getTime())) {
                  // Import playbackStore dynamically to avoid circular dependency
                  import('../store/playbackStore.js').then(({ setSelectedTime }) => {
                    log('🧹 SelectionStore: Setting selectedTime to start time of last added event:', startTime.toISOString());
                    setSelectedTime(startTime, 'selectionStore');
                  }).catch(error => {
                    logError('🧹 SelectionStore: Error importing playbackStore:', error);
                  });
                } else {
                  warn(`🧹 SelectionStore: Invalid start time for event ${lastNewlyAddedEventId}:`, lastEventRange.starttime);
                }
              } catch (error) {
                logError(`🧹 SelectionStore: Error parsing start time for event ${lastNewlyAddedEventId}:`, error);
              }
            } else {
              debug(`🧹 SelectionStore: No time range found for last added event ${lastNewlyAddedEventId}`);
            }
          }
          // Reset flag after async operations complete
          resetFlag();
        }).catch(error => {
          logError('🧹 SelectionStore: Error fetching event time ranges:', error);
          // On error, clear selectedRanges to ensure map updates
          setSelectedRanges([]);
          setHasSelection(false);
          // Reset flag even on error
          resetFlag();
        });
      }).catch(error => {
        logError('🧹 SelectionStore: Error importing unifiedDataStore:', error);
        // Reset flag even on import error
        resetFlag();
      });
    }).catch(error => {
      logError('🧹 SelectionStore: Error in async operation:', error);
      // Reset flag even on outer promise error
      resetFlag();
    });
  } else {
    resetFlag();
  }
  };
  if (deferWrite) {
    // Use setTimeout(0) instead of queueMicrotask so Solid's runUpdates/completeUpdates run in a new event-loop turn and don't overflow the stack
    setTimeout(() => {
      doWrite();
      runFollowUp();
    }, 0);
    return;
  }
  doWrite();
  runFollowUp();
};

// Toggle a list of event IDs in the global selection. Adds missing IDs and removes existing ones.
export function toggleEventIds(eventIds: number[]): void {
  try {
    const ids = Array.isArray(eventIds)
      ? eventIds.filter((e): e is number => typeof e === 'number' && !isNaN(e))
      : [];
    if (ids.length === 0) {
      return;
    }

    const current = new Set<number>(selectedEvents());
    let changed = false;
    ids.forEach(id => {
      if (current.has(id)) {
        current.delete(id);
        changed = true;
      } else {
        current.add(id);
        changed = true;
      }
    });

    if (changed) {
      const updated = Array.from(current);
      setSelectedEvents(updated);
      setHasSelection(updated.length > 0);
      setTriggerSelection(true);
    }
  } catch (error) {
    logError('SelectionStore.toggleEventIds error:', error);
  }
}

// Hidden events (session-only, not synced; cleared on full page reload)
export const hiddenEvents = (): number[] => {
  try {
    const events = hiddenEventsState();
    return Array.isArray(events) ? events.filter((e): e is number => typeof e === 'number' && !isNaN(e)) : [];
  } catch (error) {
    logError("Error accessing hiddenEvents:", error);
    return [];
  }
};
export const setHiddenEvents = (value: number[] | ((prev: number[]) => number[])) => {
  const prev = hiddenEventsState();
  const next = typeof value === 'function' ? value(prev) : value;
  const clean = Array.isArray(next) ? next.filter((e): e is number => typeof e === 'number' && !isNaN(e)) : [];
  setHiddenEventsState(clean);
};
export const isEventHidden = (eventId: number): boolean => hiddenEvents().includes(eventId);

export function hideSelectedEvents(): void {
  const toHide = selectedEvents();
  if (toHide.length === 0) return;
  setHiddenEventsState(prev => [...new Set([...prev, ...toHide])]);
  clearSelection();
}

export const selectedRanges = () => {
  try {
    const ranges = selectedRangesState();
    return Array.isArray(ranges) ? ranges : [];
  } catch (error) {
    logError("Error accessing selectedRanges:", error);
    return [];
  }
};

export const setSelectedRanges = (value: EventData[]) => {
  log('🧹 SelectionStore: setSelectedRanges called with', value?.length || 0, 'ranges:', value);
  try {
    setSelectedRangesState(value);
    log('🧹 SelectionStore: selectedRangesState updated, current value:', selectedRangesState());
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[SelectionStore] setSelectedRanges skipped - BroadcastChannel is closed`);
    } else {
      warn(`[SelectionStore] Error in setSelectedRanges:`, error);
    }
  }
  
  // Broadcast selection update to other windows
  try {
    if (typeof window !== 'undefined' && !isUpdatingFromCrossWindow && window.opener && !window.opener.closed) {
      log('🧹 SelectionStore: Broadcasting selectedRanges update to parent window');
      window.opener.postMessage({
        type: 'SELECTION_UPDATE_FROM_CHILD',
        payload: {
          type: 'SELECTION_CHANGE',
          selectedRanges: value,
          hasSelection: value && value.length > 0
        },
        windowName: window.name
      }, window.location.origin);
    }
  } catch (error) {
    logError('🧹 SelectionStore: Error broadcasting selectedRanges update:', error);
  }
};

export const selectedGroupKeys = (): (string | number)[] => {
  try {
    const v = selectedGroupKeysState();
    return Array.isArray(v) ? v : [];
  } catch (error) {
    logError("Error accessing selectedGroupKeys:", error);
    return [];
  }
};

export const setSelectedGroupKeys = (value: (string | number)[] | ((prev: (string | number)[]) => (string | number)[])) => {
  try {
    const next = typeof value === 'function' ? value(selectedGroupKeys()) : value;
    const nextArray = Array.isArray(next) ? next : [];
    setSelectedGroupKeysState(nextArray);
    // Keep hasSelection in sync for grouped maneuver timeseries (group keys are selection, not event IDs)
    const hasGroupKeys = nextArray.length > 0;
    const hasEventSelection = selectedEvents().length > 0 || (selectedRange() && selectedRange().length > 0) || (selectedRanges() && selectedRanges().length > 0);
    setHasSelection(hasGroupKeys || hasEventSelection);
  } catch (error: any) {
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[SelectionStore] setSelectedGroupKeys skipped - BroadcastChannel is closed`);
    } else {
      warn(`[SelectionStore] Error in setSelectedGroupKeys:`, error);
    }
  }
  try {
    if (typeof window !== 'undefined' && !isUpdatingFromCrossWindow && window.opener && !window.opener.closed) {
      const next = typeof value === 'function' ? value(selectedGroupKeys()) : value;
      const keysArray = Array.isArray(next) ? next : [];
      window.opener.postMessage({
        type: 'SELECTION_UPDATE_FROM_CHILD',
        payload: {
          type: 'SELECTION_CHANGE',
          selectedGroupKeys: keysArray,
          hasSelection: keysArray.length > 0 || selectedEvents().length > 0 || (selectedRange() && selectedRange().length > 0) || (selectedRanges() && selectedRanges().length > 0)
        },
        windowName: window.name
      }, window.location.origin);
    }
  } catch (error) {
    logError('🧹 SelectionStore: Error broadcasting selectedGroupKeys update:', error);
  }
};

// Convert triggerUpdate
// Wrap in createRoot to avoid cleanup warnings from createSyncSignal's internal effects
let triggerUpdateState: any;
let setTriggerUpdateState: any;
let _syncTriggerUpdate: any;
let triggerSelectionState: any;
let setTriggerSelectionState: any;
let _syncTriggerSelection: any;

createRoot(() => {
  // Local-only pulses: avoid cross-window races when multiple maneuver windows each clear the same bit.
  // Data (selection, filtered in each doc) still syncs via other signals / postMessage; views react to filtered().
  [triggerUpdateState, setTriggerUpdateState, _syncTriggerUpdate] = createSyncSignal(false, {
    key: "triggerUpdate",
    autoSync: false
  });
  
  [triggerSelectionState, setTriggerSelectionState, _syncTriggerSelection] = createSyncSignal(false, {
    key: "triggerSelection",
    autoSync: false
  });
});

export const triggerUpdate = () => Boolean(triggerUpdateState());

export const setTriggerUpdate = (value: boolean) => {
  try {
    setTriggerUpdateState(value);
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    // This is a non-critical error - the local state will still update
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[SelectionStore] setTriggerUpdate skipped - BroadcastChannel is closed`);
    } else {
      warn(`[SelectionStore] Error in setTriggerUpdate:`, error);
    }
  }
};

export const triggerSelection = () => Boolean(triggerSelectionState());
export const setTriggerSelection = (value: boolean) => {
  try {
    setTriggerSelectionState(value);
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    // This is a non-critical error - the local state will still update
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[SelectionStore] setTriggerSelection skipped - BroadcastChannel is closed`);
    } else {
      warn(`[SelectionStore] Error in setTriggerSelection:`, error);
    }
  }
};

// Removed legacy filter signals and options (migrated to filterStore)

// Expose selectedDate via selectionStore for consumers expecting it here
export const selectedDate = () => {
  try {
    return persistantStore.selectedDate ? persistantStore.selectedDate() : '';
  } catch (error) {
    return '';
  }
};

export interface ClearSelectionOptions {
  /** When true, do not clear filter store (selectedSources, etc.). Use when switching upwind/downwind so perf table keeps sources. */
  preserveFilters?: boolean;
}

export function clearSelection(options?: ClearSelectionOptions): void {
  const preserveFilters = options?.preserveFilters === true;
  log('🧹 SelectionStore: clearSelection called', preserveFilters ? '(preserveFilters)' : '');
  
  const currentCutEvents = cutEvents();
  const currentHasSelection = hasSelection();
  
  log('🧹 SelectionStore: Current state before clearing', {
    cutEvents: currentCutEvents?.length || 0,
    hasSelection: currentHasSelection
  });
  
  // Note: Map updates are now handled by triggerUpdate mechanism
  
  // Clear the TimeSeries brush if it exists (avoid infinite loops with timeout)
  if (typeof window !== 'undefined' && window.clearMapBrush) {
    setTimeout(() => {
      try {
        if (window.clearMapBrush) {
          window.clearMapBrush();
          debug('SelectionBanner: Cleared TimeSeries brush');
        }
      } catch (error) {
        warn('Error clearing TimeSeries brush:', error);
      }
    }, 10); // Small delay to avoid race conditions
  }
  
  // Hierarchical clearing logic with 4 levels:
  // 1. All data (default)
  // 2. Filtered data (after applying filters)
  // 3. Cut data (after cutting a selection from filtered data)
  // 4. Active selection (new selection made on cut data)
  const hasCuts = currentCutEvents && Array.isArray(currentCutEvents) && currentCutEvents.length > 0;
  const currentSelectedEvents = selectedEvents();
  const currentSelection = selection();
  const hasActiveSelections = (currentSelectedEvents && currentSelectedEvents.length > 0) ||
                              (currentSelection && currentSelection.length > 0);

  // Run all updates in next event-loop turn (setTimeout 0) so Solid's runUpdates/completeUpdates get a fresh stack.
  // Use setSelectedEvents([], { defer: false }) so the write runs synchronously inside this tick.
  setTimeout(() => {
    batch(() => {
      if (hasCuts) {
        setSelection([]);
        setSelectedEvents([], { defer: false });
        setCutEvents([]);
        setSelectedRange([]);
        setSelectedRanges([]);
        setSelectedGroupKeys([]);
        setHasSelection(false);
        setTriggerSelection(true);
        setTriggerUpdate(true);
        setIsCut(false);
      } else if (currentHasSelection || hasActiveSelections) {
        setSelection([]);
        setSelectedEvents([], { defer: false });
        setSelectedRange([]);
        setSelectedRanges([]);
        setSelectedGroupKeys([]);
        setHasSelection(false);
        setTriggerSelection(true);
        setTriggerUpdate(true);
        if (currentCutEvents && currentCutEvents.length > 0) {
          setIsCut(true);
        }
      } else {
        setSelection([]);
        setSelectedEvents([], { defer: false });
        setCutEvents([]);
        setSelectedRange([]);
        setSelectedRanges([]);
        setSelectedGroupKeys([]);
        setHasSelection(false);
        setTriggerSelection(true);
        setTriggerUpdate(true);
        setIsCut(false);
        if (!preserveFilters) {
          clearAllFilters();
        }
      }
    });
    // Clear any active brushes on map/timeseries UIs
    try { if (typeof window !== 'undefined' && (window as any).clearMapBrush) { (window as any).clearMapBrush(); } } catch {}
    try { if (typeof window !== 'undefined' && (window as any).clearTimeSeriesBrush) { (window as any).clearTimeSeriesBrush(); } } catch {}
    // Clear persistent storage (IndexedDB) so it doesn't re-hydrate with stale selectedRange on next read.
    try {
      clearSyncData("selection");
      clearSyncData("cutEvents");
      clearSyncData("selectedRange");
      clearSyncData("selectedRanges");
      clearSyncData("selectedEvents");
      clearSyncData("selectedGroupKeys");
      clearSyncData("hasSelection");
      clearSyncData("isCut");
      if (typeof window !== 'undefined' && window.sessionStorage) {
        sessionStorage.setItem('selectionCleared', 'true');
      }
    } catch (error) {
      warn("Error clearing persistent selection data:", error);
    }
  }, 0);
}

// Function to clear only the active selection while preserving cut data
export function clearActiveSelection(): void {
  const currentCutEvents = cutEvents();
  const _currentHasSelection = hasSelection();
  const currentIsCut = isCut();
  
  // If we have cut data (whether there's a selection or not), clear selection but keep cuts
  if (currentCutEvents && currentCutEvents.length > 0 && currentIsCut) {
    setTimeout(() => {
      batch(() => {
        setSelection([]);
        setSelectedEvents([], { defer: false });
        setSelectedRange([]);
        setSelectedRanges([]);
        setSelectedGroupKeys([]);
        setHasSelection(false);
        setTriggerSelection(true);
        setTriggerUpdate(true);
      });
    }, 0);
    log('🧹 SelectionStore: clearActiveSelection - Cleared selection, keeping cut data');
  }
  // If we have no cut data, clear everything normally
  else {
    try {
      clearSyncData("cutEvents");
      clearSyncData("isCut");
    } catch (error) {
      warn("Error clearing cut data from IndexedDB:", error);
    }
    setTimeout(() => {
      batch(() => {
        setSelection([]);
        setSelectedEvents([], { defer: false });
        setCutEvents([]);
        setSelectedRange([]);
        setSelectedRanges([]);
        setSelectedGroupKeys([]);
        setHasSelection(false);
        setTriggerSelection(true);
        setTriggerUpdate(true);
        setIsCut(false);
        clearAllFilters();
      });
    }, 0);
  }
}

// Function to completely clear everything including cut data
export function clearAllData(): void {
  try {
    clearSyncData("cutEvents");
    clearSyncData("isCut");
    clearSyncData("selection");
    clearSyncData("selectedRange");
    clearSyncData("selectedRanges");
    clearSyncData("selectedEvents");
    clearSyncData("selectedGroupKeys");
    clearSyncData("hasSelection");
  } catch (error) {
    warn("Error clearing selection data from IndexedDB:", error);
  }
  setTimeout(() => {
    batch(() => {
      setSelection([]);
      setSelectedEvents([], { defer: false });
      setCutEvents([]);
      setSelectedRange([]);
      setSelectedRanges([]);
      setSelectedGroupKeys([]);
      setHasSelection(false);
      setTriggerSelection(true);
      setTriggerUpdate(true);
      setIsCut(false);
      clearAllFilters();
    });
  }, 0);
}

// Function to clear all selection data on application startup
export function clearSelectionOnStartup(): void {
  // Check if selection was intentionally cleared by the user
  const selectionWasCleared = typeof window !== 'undefined' && window.sessionStorage?.getItem('selectionCleared') === 'true';
  
  // If selection was cleared, ensure all persistent storage is cleared
  if (selectionWasCleared) {
    log('🧹 SelectionStore: Selection was cleared by user, ensuring storage is cleared on reload');
    try {
      // Clear syncstore's IndexedDB storage (this is what createSyncSignal uses)
      clearSyncData("selection");
      clearSyncData("cutEvents");
      clearSyncData("selectedRange");
      clearSyncData("selectedRanges");
      clearSyncData("selectedEvents");
      clearSyncData("selectedGroupKeys");
      clearSyncData("hasSelection");
      clearSyncData("isCut");
    } catch (error) {
      warn("Error clearing persistent selection data on startup:", error);
    }
    
    // Clear all selection and cut data
    setSelection([]);
    setSelectedEvents([]);
    setCutEvents([]);
    setSelectedRange([]);
    setSelectedRanges([]);
    setSelectedGroupKeys([]);
    setHasSelection(false);
    setTriggerSelection(false);
    setTriggerUpdate(false);
    setIsCut(false);
    
    // Clear all filter data using filterStore's clearAllFilters
    clearAllFilters();
    
    // Do not clear race/leg/grade options here - they are repopulated by the active view
    // (FleetMap, MapContainer, FleetTimeSeries, etc.) when data loads. Clearing on every
    // startup caused "race filters not populating anywhere".
    
    // Remove the flag since we've handled it
    if (typeof window !== 'undefined' && window.sessionStorage) {
      sessionStorage.removeItem('selectionCleared');
    }
    return;
  }
  
  // Check if there's persisted cut data using the sync signals (not localStorage)
  // The sync signals will have already restored from IndexedDB by this point
  const currentCutEvents = cutEvents();
  const currentIsCut = isCut();
  
  // Validate that cutEvents are actually valid cut data and not accidentally stored dataset/selection ranges
  // Invalid cutEvents should be cleared on startup
  const isValidCutData = currentCutEvents && currentCutEvents.length > 0 && currentIsCut;
  let shouldClearCutEvents = false;
  
  if (isValidCutData) {
    // Check ALL items in cutEvents, not just the first one
    // If ANY item has type: 'range', it's invalid and should be cleared
    const hasInvalidRangeType = currentCutEvents.some(item => 
      item && typeof item === 'object' && 'type' in item && item.type === 'range'
    );
    
    if (hasInvalidRangeType) {
      log(`[SelectionStore] clearSelectionOnStartup: Detected invalid cutEvents with type: 'range'. This looks like a selectedRange that was incorrectly stored as cutEvents. Clearing all cutEvents.`, {
        cutEvents: currentCutEvents,
        isCut: currentIsCut,
        invalidItems: currentCutEvents.filter(item => 
          item && typeof item === 'object' && 'type' in item && item.type === 'range'
        )
      });
      shouldClearCutEvents = true;
    }
    // Check if any time range is suspiciously large (might be a dataset time range)
    else {
      const hasLargeRange = currentCutEvents.some(item => {
        if (item && typeof item === 'object' && 'start_time' in item && 'end_time' in item) {
          try {
            const startTime = new Date(item.start_time as string).getTime();
            const endTime = new Date(item.end_time as string).getTime();
            const rangeDuration = endTime - startTime;
            
            // If range is > 24 hours, it's likely a dataset time range, not a user cut
            if (rangeDuration > 24 * 60 * 60 * 1000) {
              return true;
            }
          } catch (dateError) {
            // Invalid date - consider it suspicious
            return true;
          }
        }
        return false;
      });
      
      if (hasLargeRange) {
        const largeRanges = currentCutEvents.filter(item => {
          if (item && typeof item === 'object' && 'start_time' in item && 'end_time' in item) {
            try {
              const startTime = new Date(item.start_time as string).getTime();
              const endTime = new Date(item.end_time as string).getTime();
              const rangeDuration = endTime - startTime;
              return rangeDuration > 24 * 60 * 60 * 1000;
            } catch {
              return true;
            }
          }
          return false;
        });
        
        warn(`[SelectionStore] clearSelectionOnStartup: Detected suspiciously large cutEvents time range(s). This might be a dataset time range incorrectly stored as cutEvents. Clearing all cutEvents.`, {
          largeRanges: largeRanges,
          isCut: currentIsCut
        });
        shouldClearCutEvents = true;
      }
    }
  }
  
  // Only preserve cut data if it's valid AND not flagged for clearing
  if (shouldClearCutEvents) {
    // Invalid cutEvents detected - clear them and everything else
    log('🧹 SelectionStore: clearSelectionOnStartup - Clearing invalid cutEvents and all selection data');
    try {
      // Clear from IndexedDB
      clearSyncData("cutEvents");
      clearSyncData("isCut");
      clearSyncData("selectedGroupKeys");
    } catch (error) {
      warn("Error clearing invalid cut data from IndexedDB:", error);
    }
    
    // Clear all selection and cut data
    setSelection([]);
    setSelectedEvents([]);
    setCutEvents([]);
    setSelectedRange([]);
    setSelectedRanges([]);
    setSelectedGroupKeys([]);
    setHasSelection(false);
    setTriggerSelection(false);
    setTriggerUpdate(false);
    setIsCut(false);
    
    // Clear all filter data using filterStore's clearAllFilters
    clearAllFilters();
    
    // Do not clear race/leg/grade options - repopulated by active view when data loads
  } else if (!currentCutEvents || currentCutEvents.length === 0) {
    // No persisted cut data - clear everything
    setSelection([]);
    setSelectedEvents([]);
    setCutEvents([]);
    setSelectedRange([]);
    setSelectedRanges([]);
    setSelectedGroupKeys([]);
    setHasSelection(false);
    setTriggerSelection(false);
    setTriggerUpdate(false);
    setIsCut(false);
    
    // Clear all filter data using filterStore's clearAllFilters
    clearAllFilters();
    
    // Do not clear race/leg/grade options - repopulated by active view when data loads
  } else {
    // Invalid cutEvents detected - clear them and everything else
    log('🧹 SelectionStore: clearSelectionOnStartup - Clearing invalid cutEvents and all selection data');
    try {
      // Clear from IndexedDB
      clearSyncData("cutEvents");
      clearSyncData("isCut");
      clearSyncData("selectedGroupKeys");
    } catch (error) {
      warn("Error clearing invalid cut data from IndexedDB:", error);
    }
    
    // Clear all selection and cut data
    setSelection([]);
    setSelectedEvents([]);
    setCutEvents([]);
    setSelectedRange([]);
    setSelectedRanges([]);
    setSelectedGroupKeys([]);
    setHasSelection(false);
    setTriggerSelection(false);
    setTriggerUpdate(false);
    setIsCut(false);
    
    // Clear all filter data using filterStore's clearAllFilters
    clearAllFilters();
    
    // Do not clear race/leg/grade options - repopulated by active view when data loads
  }
}

// Update cutSelection to handle potential void returns
export function cutSelection(): void {
    const currentSelectedRanges = selectedRanges();
    const currentSelectedEvents = selectedEvents();
    const currentBrushRange = selectedRange();
    const currentCutEvents = cutEvents();

    // Check if cutEvents already contains event IDs (not time ranges) - this means the cut was already handled
    // by PerformanceHistory pages, and we should skip time range fetching
    if (currentCutEvents && currentCutEvents.length > 0) {
      const firstCutItem = currentCutEvents[0];
      // If cutEvents contains event IDs (numbers or objects with event_id but no start_time/end_time),
      // then the cut was already handled by PerformanceHistory - skip fetching time ranges
      const isEventIdCut = typeof firstCutItem === 'number' || 
                          (firstCutItem && typeof firstCutItem === 'object' && 'event_id' in firstCutItem && !('start_time' in firstCutItem));
      
      if (isEventIdCut) {
        // If selectedEvents exist and match cutEvents, or if selectedEvents is empty (already cleared),
        // the cut was already handled - skip fetching time ranges
        if (currentSelectedEvents && currentSelectedEvents.length > 0) {
          // Extract event IDs from cutEvents and selectedEvents to compare
          const cutEventIds = new Set(
            currentCutEvents.map(e => typeof e === 'number' ? e : (e?.event_id || null)).filter(id => id !== null)
          );
          const selectedEventIds = new Set(
            currentSelectedEvents.filter((id): id is number => typeof id === 'number' && !isNaN(id))
          );
          
            // If the selected events match the cut events, the cut was already handled
            if (cutEventIds.size === selectedEventIds.size && 
                Array.from(cutEventIds).every(id => selectedEventIds.has(id))) {
            log('🧹 SelectionStore: cutSelection - Cut already handled with event IDs (matching selectedEvents), skipping time range fetch');
            batch(() => {
              setSelectedEvents([]);
              setSelection([]);
              setSelectedRange([]);
              setSelectedRanges([]);
              setHasSelection(false);
              setIsCut(true);
            });
            return;
          }
        } else {
          // cutEvents contains event IDs but selectedEvents is empty - cut was already handled
          // (PerformanceHistory pages clear selectedEvents before setting cutEvents)
          log('🧹 SelectionStore: cutSelection - Cut already handled with event IDs (selectedEvents cleared)');
          batch(() => {
            setSelectedEvents([]);
            setSelection([]);
            setSelectedRange([]);
            setSelectedRanges([]);
            setHasSelection(false);
            setIsCut(true);
          });
          return;
        }
      }
    }

    // Prefer event-based ranges (which have start_time/end_time); fallback to brush range
    // When selectedEvents are set, selectedRanges should already be populated with time ranges
    let rangesToCut: EventData[] = [];
    
    if (currentSelectedRanges && currentSelectedRanges.length > 0) {
      // Use selectedRanges (time ranges with start_time/end_time) - this is what we need for filtering
      rangesToCut = currentSelectedRanges;
      log('🧹 SelectionStore: cutSelection - Using selectedRanges for cut:', rangesToCut.length, 'ranges');
    } else if (currentSelectedEvents && currentSelectedEvents.length > 0) {
      // selectedEvents should ALWAYS be event IDs (numbers) - time ranges go in selectedRanges!
      // If selectedRanges is empty, we need to decide:
      // - For PerformanceHistory pages: Use event IDs directly (no time range fetch needed)
      // - For map-based selections: Fetch time ranges for map filtering
      
      // If selectedRanges is empty, it means the selection was made from events (not from a map brush)
      // In this case, use event IDs directly (matches FleetManeuvers and ManeuversHistory behavior)
      if (currentSelectedRanges.length === 0) {
        // Maneuvers/PerformanceHistory context: Use event IDs directly, skip time range fetch
        // Batch all updates so map/view re-render once with cut data only (no flash of full tracks).
        // Do NOT set triggerUpdate here - let the view's applyFilters effect run first (on isCut/cutEvents),
        // update filtered()/tableData, then call setTriggerUpdate(true). That way the map draws once with cut data.
        log('🧹 SelectionStore: cutSelection - Cutting from selectedEvents (selectedRanges empty), using event IDs directly');
        batch(() => {
          setCutEvents(currentSelectedEvents);
          setSelectedEvents([]);
          setSelection([]);
          setSelectedRange([]);
          setSelectedRanges([]);
          setHasSelection(false);
          setIsCut(true);
        });
        return;
      }
      
      // Map-based selection context: selectedRanges is populated, so use those ranges
      // (This path is for time series brush selections that create time ranges)
      
      // Import unifiedDataStore dynamically to avoid circular dependency
      import('../store/unifiedDataStore.js').then(({ unifiedDataStore }) => {
        unifiedDataStore.getEventTimeRanges(currentSelectedEvents).then((timeRangesMap) => {
          const ranges = Array.from(timeRangesMap.entries()).map(([eventId, range]) => ({
            event_id: eventId,
            start_time: range.starttime,
            end_time: range.endtime,
            type: 'event'
          }));
          
          if (ranges.length > 0) {
            logError('🧹 SelectionStore: cutSelection - Fetched time ranges, setting cutEvents:', ranges.length, 'ranges');
            batch(() => {
              setCutEvents(ranges);
              setSelectedEvents([]);
              setHasSelection(false);
              setSelection([]);
              setSelectedRange([]);
              setSelectedRanges([]);
              setIsCut(true);
            });
          } else {
            log('🧹 SelectionStore: cutSelection - No time ranges found for events');
            batch(() => {
              setHasSelection(false);
              setIsCut(false);
            });
          }
        }).catch(error => {
          logError('🧹 SelectionStore: cutSelection - Error fetching event time ranges:', error);
          batch(() => {
            setHasSelection(false);
            setIsCut(false);
          });
        });
      });
      return; // Return early since we're handling this asynchronously
    } else if (currentBrushRange && currentBrushRange.length > 0) {
      // Fallback to brush range
      rangesToCut = currentBrushRange;
      log('🧹 SelectionStore: cutSelection - Using brush range for cut');
    }

    if (rangesToCut.length > 0) {
      // Extract event IDs from ranges if available (for performance pages)
      const eventIdsFromRanges = rangesToCut
        .map(r => r.event_id)
        .filter((id): id is number => typeof id === 'number' && !isNaN(id));
      
      // Check if we're on a performance page context:
      // - If we have event IDs in the ranges AND we originally had selectedEvents (not just brush selection)
      // - OR if we're using selectedRanges that came from selectedEvents
      const _isPerformancePageContext = (eventIdsFromRanges.length > 0 && currentSelectedEvents.length > 0) ||
                                       (rangesToCut === currentSelectedRanges && currentSelectedRanges.length > 0);
      
      // Normalize ranges before passing to setCutEvents
      // setCutEvents rejects objects with type: 'range', so we need to convert them to type: 'event' or remove the type
      // CRITICAL: This normalization MUST happen before setCutEvents to prevent invalid data from being stored
      const normalizedRanges = rangesToCut.map(range => {
        // If the range has type: 'range', change it to type: 'event' or remove it
        // This ensures setCutEvents accepts the range
        if (range && typeof range === 'object' && 'type' in range && range.type === 'range') {
          const { type, ...rest } = range;
          // If the range has start_time/end_time, it should be treated as an event
          // Otherwise, just remove the type property
          if ('start_time' in rest || 'end_time' in rest) {
            return { ...rest, type: 'event' as const };
          }
          return rest;
        }
        // Also handle ranges without a type property but with start_time/end_time (from TimeSeries brush)
        // These should have type: 'event' added to be consistent
        if (range && typeof range === 'object' && !('type' in range) && ('start_time' in range || 'end_time' in range)) {
          return { ...range, type: 'event' as const };
        }
        return range;
      });
      
      // Batch all updates so view's applyFilters runs first (updates filtered/tableData), then it sets triggerUpdate.
      batch(() => {
        setCutEvents(normalizedRanges);
        setIsCut(true);
        setSelection([]);
        setSelectedRange([]);
        setSelectedRanges([]);
        setSelectedEvents([]);
        setHasSelection(false);
      });
      
      // Debug: Log all ranges to verify they're preserved
      rangesToCut.forEach((range, index) => {
        if (range.start_time && range.end_time) {
          log(`🧹 SelectionStore: cutSelection - Range ${index + 1}: ${range.start_time} to ${range.end_time}`);
        }
      });
      // Note: Brush clearing is handled by MapTimeSeries after data is drawn
    } else {
      // Nothing to cut; ensure state reflects no active selection
      log('🧹 SelectionStore: cutSelection - No ranges to cut');
      batch(() => {
        setHasSelection(false);
        setIsCut(false);
      });
    }
}

// Auto-control TimeWindow visibility based on selections
// This effect is wrapped in createRoot to avoid the computation warning
let timeWindowEffectDispose: (() => void) | null = null;

export function initializeSelectionStore(): void {
  if (timeWindowEffectDispose) {
    timeWindowEffectDispose();
  }
  
  timeWindowEffectDispose = createRoot((dispose) => {
    createEffect(() => {
      // Check if there are active selections
      const hasSelections = selectedEvents().length > 0 || selectedRange().length > 0 || selectedRanges().length > 0;
      
      // If there are selections, hide TimeWindow button
      if (hasSelections) {
        setAllowTimeWindow(false);
      } else {
        // Restore TimeWindow button when no selections
        setAllowTimeWindow(true);
      }
    });

    // When group display mode changes (OFF <-> ON <-> MIX), clear active selection so the view
    // doesn't show a selection that doesn't apply to the new mode (e.g. selectedGroupKeys in OFF, or brush selection in ON/MIX).
    let prevGroupDisplayMode: string | undefined;
    createEffect(() => {
      const mode = groupDisplayMode();
      if (prevGroupDisplayMode !== undefined && prevGroupDisplayMode !== mode) {
        clearActiveSelection();
      }
      prevGroupDisplayMode = mode;
    });

    return dispose;
  });
}

export function disposeSelectionStore(): void {
  // Clean up the time window effect
  if (timeWindowEffectDispose) {
    timeWindowEffectDispose();
    timeWindowEffectDispose = null;
  }
  
  // Clean up cross-window event listener
  if (cleanupFunction) {
    cleanupFunction();
    cleanupFunction = null;
  }
  
  // Clean up all sync signals - clearSyncData now automatically triggers cleanup
  // Using individual calls to be explicit about which signals we're cleaning up
  clearSyncData("isSelectionLoading");
  clearSyncData("hasSelection");
  clearSyncData("isCut");
  clearSyncData("selection");
  clearSyncData("cutEvents");
  clearSyncData("selectedRange");
  clearSyncData("selectedRanges");
  clearSyncData("selectedEvents");
  clearSyncData("selectedGroupKeys");
  clearSyncData("triggerUpdate");
  clearSyncData("triggerSelection");
  clearSyncData("allowTimeWindow");
}

// This function should be called within a component to properly register cleanup
let appCleanupDispose: (() => void) | null = null;
export function registerSelectionStoreCleanup(): void {
  if (appCleanupDispose) {
    appCleanupDispose();
  }
  appCleanupDispose = createRoot((dispose) => {
    // Wrap onCleanup in createEffect to ensure it's called within a reactive context
    // Use untrack to prevent the effect from tracking any reactive dependencies
    createEffect(() => {
      untrack(() => {
        onCleanup(() => {
          disposeSelectionStore();
        });
      });
    });
    return dispose;
  });
}

