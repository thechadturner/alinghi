import { createSignal, createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import { createRoot } from "solid-js";
import { createSyncSignal } from "@solidjs/sync";
import { warn } from "../utils/console";

// Cross-window synchronization for global store signals
let isUpdatingFromCrossWindow = false;
let pendingBroadcast = false;
const dirtyKeys = new Set<string>();
// Track when we last updated from a setter to distinguish own events from cross-window events
let lastSetterUpdateTime = 0;
// Track timestamps of events we've sent to avoid processing our own broadcasts
const sentEventTimestamps = new Set<number>();

// Function to broadcast global store updates to parent window (for child windows)
const scheduleBroadcast = () => {
  if (pendingBroadcast || isUpdatingFromCrossWindow) return;
  pendingBroadcast = true;
  queueMicrotask(() => {
    try {
      if (typeof window !== 'undefined' && dirtyKeys.size > 0) {
        const payload: Record<string, unknown> = {};
        
        // Build payload from dirty keys
        if (dirtyKeys.has('eventType')) {
          payload.eventType = eventType();
        }
        if (dirtyKeys.has('phase')) {
          payload.phase = phase();
        }
        if (dirtyKeys.has('color')) {
          payload.color = color();
        }
        if (dirtyKeys.has('grouped')) {
          payload.grouped = grouped();
          payload.groupDisplayMode = groupDisplayMode();
        }
        if (dirtyKeys.has('tws')) {
          payload.tws = tws();
        }
        if (dirtyKeys.has('grade')) {
          payload.grade = grade();
        }
        
        // Always dispatch CustomEvent locally for same-window components (including Sidebar)
        // This ensures the main window's Sidebar can catch changes and broadcast to child windows
        // Mark this as a local event (not cross-window) by not including _crossWindowSync flag
        const timestamp = Date.now();
        window.dispatchEvent(new CustomEvent('globalStoreUpdate', { detail: payload }));
        
        // Send to parent window for cross-window sync (only if this is a child window)
        // Main window doesn't have opener, so it relies on Sidebar listening to the CustomEvent
        if (window.opener && !window.opener.closed) {
          // Add timestamp to track this event
          const childPayload = {
            ...payload,
            _timestamp: timestamp
          };
          sentEventTimestamps.add(timestamp);
          // Clean up old timestamps (keep only last 100)
          if (sentEventTimestamps.size > 100) {
            const oldest = Math.min(...Array.from(sentEventTimestamps));
            sentEventTimestamps.delete(oldest);
          }
          window.opener.postMessage({ 
            type: 'GLOBAL_STORE_UPDATE_FROM_CHILD', 
            payload: childPayload, 
            windowName: window.name 
          }, window.location.origin);
        }
      }
    } catch (error) {
      warn('GlobalStore: Error broadcasting global store update:', error);
    } finally {
      dirtyKeys.clear();
      pendingBroadcast = false;
    }
  });
};

const markDirtyAndBroadcast = (key: string) => {
  dirtyKeys.add(key);
  scheduleBroadcast();
};

// Type definitions
export interface TooltipData {
  visible: boolean;
  x: number;
  y: number;
  content: string;
}

export interface XRange {
  min: number;
  max: number;
}

export interface ManeuverData {
  [key: string]: any;
}

export interface TableData {
  [key: string]: any;
}

// Group display mode: OFF = no grouping, ON = grouped with all tracks interactive, MIX = grouped with only selected tracks interactive
export type GroupDisplayMode = 'OFF' | 'ON' | 'MIX';

function normalizeGroupDisplayMode(val: string): GroupDisplayMode {
  const u = String(val).trim().toUpperCase();
  if (u === 'ON' || u === 'MIX') return u;
  return 'OFF';
}

// Signal/memo refs (assigned inside createRoot)
let stepSig: ReturnType<typeof createSignal<number>>;
let maxStepSig: ReturnType<typeof createSignal<number>>;
let proceedSig: ReturnType<typeof createSignal<boolean>>;
let startTimeSig: ReturnType<typeof createSignal<string>>;
let endTimeSig: ReturnType<typeof createSignal<string>>;
let dateSig: ReturnType<typeof createSignal<string>>;
let tooltipSig: ReturnType<typeof createSignal<TooltipData>>;
let maneuversSig: ReturnType<typeof createSignal<ManeuverData[]>>;
let tabledataSig: ReturnType<typeof createSignal<TableData[]>>;
let filteredSig: ReturnType<typeof createSignal<ManeuverData[]>>;
let phaseSignal: ReturnType<typeof createSignal<string>>;
let colorSignal: ReturnType<typeof createSignal<string>>;
let eventTypeSignal: ReturnType<typeof createSignal<string>>;
let groupDisplayModeSignal: ReturnType<typeof createSignal<GroupDisplayMode>>;
let groupedMemo: ReturnType<typeof createMemo<boolean>>;
let sidebarMenuRefreshTriggerSig: ReturnType<typeof createSignal<number>>;
let normalizedSig: ReturnType<typeof createSignal<boolean>>;
let twsSig: ReturnType<typeof createSignal<string>>;
let gradeSig: ReturnType<typeof createSignal<string>>;
let xRangeStore: ReturnType<typeof createStore<{ min: number; max: number }>>;
let hasVideoMenuSig: ReturnType<typeof createSignal<boolean>>;

createRoot(() => {
  // EVENT.jsx
  stepSig = createSignal(0);
  maxStepSig = createSignal(0);
  proceedSig = createSignal(false);
  startTimeSig = createSignal('');
  endTimeSig = createSignal('');
  dateSig = createSignal('');

  // MANEUVER.jsx
  tooltipSig = createSignal<TooltipData>({ visible: false, x: 0, y: 0, content: '' });
  maneuversSig = createSignal<ManeuverData[]>([]);
  tabledataSig = createSignal<TableData[]>([]);
  filteredSig = createSignal<ManeuverData[]>([]);

  // Internal signals
  phaseSignal = createSignal('FULL');
  colorSignal = createSignal('TACK');
  eventTypeSignal = createSignal('TACK');
  groupDisplayModeSignal = createSignal<GroupDisplayMode>('OFF');
  groupedMemo = createMemo(() => groupDisplayModeSignal[0]() !== 'OFF');

  sidebarMenuRefreshTriggerSig = createSignal(0);
  normalizedSig = createSignal(true);
  twsSig = createSignal('ALL');
  gradeSig = createSignal('> 1');
  xRangeStore = createStore({ min: 0, max: 100 });
  hasVideoMenuSig = createSignal(false);
});

// Internal setters (used by cross-window handler)
const setPhaseInternal = phaseSignal![1];
const setColorInternal = colorSignal![1];
const setEventTypeInternal = eventTypeSignal![1];
const setGroupDisplayModeInternal = groupDisplayModeSignal![1];
const setTwsInternal = twsSig![1];
const setGradeInternal = gradeSig![1];

// Public accessors – EVENT.jsx
export const [step, setStep] = stepSig!;
export const [maxStep, setMaxStep] = maxStepSig!;
export const [proceed, setProceed] = proceedSig!;
export const [startTime, setStartTime] = startTimeSig!;
export const [endTime, setEndTime] = endTimeSig!;
export const [date, setDate] = dateSig!;

// MANEUVER.jsx
export const [tooltip, setTooltip] = tooltipSig!;
export const [maneuvers, setManeuvers] = maneuversSig!;
export const [tabledata, setTableData] = tabledataSig!;
export const [filtered, setFiltered] = filteredSig!;

export const phase = phaseSignal![0];
export const color = colorSignal![0];
export const eventType = eventTypeSignal![0];
export const groupDisplayMode = groupDisplayModeSignal![0];
export const grouped = groupedMemo!;

// Public setters (with broadcast support)
export const setPhase = (value: string) => {
  setPhaseInternal(value);
  if (!isUpdatingFromCrossWindow) {
    lastSetterUpdateTime = Date.now();
    markDirtyAndBroadcast('phase');
  }
};

export const setColor = (value: string) => {
  setColorInternal(value);
  if (!isUpdatingFromCrossWindow) {
    lastSetterUpdateTime = Date.now();
    markDirtyAndBroadcast('color');
  }
};

export const setEventType = (value: string) => {
  setEventTypeInternal(value);
  if (!isUpdatingFromCrossWindow) {
    lastSetterUpdateTime = Date.now();
    markDirtyAndBroadcast('eventType');
  }
};

export const setGroupDisplayMode = (mode: string) => {
  const value = normalizeGroupDisplayMode(mode);
  setGroupDisplayModeInternal(value);
  if (!isUpdatingFromCrossWindow) {
    lastSetterUpdateTime = Date.now();
    markDirtyAndBroadcast('grouped');
  }
};

export const setGrouped = (value: boolean) => {
  setGroupDisplayModeInternal(value ? 'ON' : 'OFF');
  if (!isUpdatingFromCrossWindow) {
    lastSetterUpdateTime = Date.now();
    markDirtyAndBroadcast('grouped');
  }
};

export const [sidebarMenuRefreshTrigger, setSidebarMenuRefreshTrigger] = sidebarMenuRefreshTriggerSig!;

// Setup cross-window synchronization after setters are defined
if (typeof window !== 'undefined') {
  const handleCrossWindowUpdate = (event: CustomEvent) => {
    const payload = event.detail;
    if (!payload) {
      return;
    }
    
    // Skip processing if we're currently updating from a setter (same-window scenario)
    // When setColor() is called, it updates the signal and dispatches the event
    // The signal is already updated, so we don't need to update it again
    if (isUpdatingFromCrossWindow) {
      // We're in the middle of processing a cross-window update, don't process our own event
      return;
    }
    
    // Check if this is a cross-window sync (has _crossWindowSync flag and timestamp)
    const isCrossWindowSync = payload._crossWindowSync === true && payload._timestamp;
    
    // If it's a cross-window sync, check if we've already processed this timestamp
    if (isCrossWindowSync && payload._timestamp) {
      if (sentEventTimestamps.has(payload._timestamp)) {
        // We sent this event, don't process it again
        return;
      }
      // Mark this timestamp as processed (but don't add to sentEventTimestamps - that's only for events we send)
      // Always process cross-window syncs from other windows
    } else {
      // This is a local event (no _crossWindowSync flag)
      // Check if this is likely our own event (from a setter in the same window)
      const timeSinceLastSetter = Date.now() - lastSetterUpdateTime;
      const valuesMatch = 
        (payload.color === undefined || String(payload.color).toUpperCase() === color()) &&
        (payload.eventType === undefined || payload.eventType === eventType()) &&
        (payload.phase === undefined || payload.phase === phase()) &&
        (payload.grouped === undefined || payload.grouped === grouped()) &&
        (payload.groupDisplayMode === undefined || payload.groupDisplayMode === groupDisplayMode()) &&
        (payload.tws === undefined || String(payload.tws) === tws()) &&
        (payload.grade === undefined || String(payload.grade) === grade());
      
      // Only skip if values match AND we recently updated via setter (within 100ms)
      // This prevents skipping legitimate cross-window updates that happen to match current values
      const isOwnEvent = valuesMatch && timeSinceLastSetter < 100;
      
      if (isOwnEvent) {
        // This is our own event from the same window - signal was already updated by setter
        // Just return, don't update again
        return;
      }
    }
    
    isUpdatingFromCrossWindow = true;
    
    if (payload.eventType !== undefined) {
      setEventTypeInternal(payload.eventType);
    }
    if (payload.phase !== undefined) {
      setPhaseInternal(payload.phase);
    }
    if (payload.color !== undefined) {
      const oldColor = color();
      const newColorValue = String(payload.color).toUpperCase();
      // Only update if the color is actually different
      if (oldColor !== newColorValue) {
        setColorInternal(newColorValue);
      }
    }
    if (payload.groupDisplayMode !== undefined) {
      setGroupDisplayModeInternal(normalizeGroupDisplayMode(String(payload.groupDisplayMode)));
    } else if (payload.grouped !== undefined) {
      setGroupDisplayModeInternal(payload.grouped ? 'ON' : 'OFF');
    }
    if (payload.tws !== undefined) {
      setTwsInternal(String(payload.tws));
    }
    if (payload.grade !== undefined) {
      setGradeInternal(String(payload.grade));
    }
    
    isUpdatingFromCrossWindow = false;
  };
  
  window.addEventListener('globalStoreUpdate', handleCrossWindowUpdate as EventListener);
}

export const [normalized, setNormalized] = normalizedSig!;
export const tws = twsSig![0];
export const setTws = (value: string) => {
  setTwsInternal(value);
  if (!isUpdatingFromCrossWindow) {
    lastSetterUpdateTime = Date.now();
    markDirtyAndBroadcast('tws');
  }
};
export const grade = gradeSig![0];
export const setGrade = (value: string) => {
  setGradeInternal(value);
  if (!isUpdatingFromCrossWindow) {
    lastSetterUpdateTime = Date.now();
    markDirtyAndBroadcast('grade');
  }
};
export const [xRange, setRange] = xRangeStore!;

// VIDEO MENU AVAILABILITY – sidebarState persistent via createSyncSignal (inside same root)
let sidebarStateState: any;
let setSidebarStateState: any;

createRoot(() => {
  [sidebarStateState, setSidebarStateState] = createSyncSignal<'project' | 'dataset' | 'live'>('project', {
    key: 'sidebarState',
    autoSync: true
  });
});

export const sidebarState = () => sidebarStateState();
export const setSidebarState = (value: 'project' | 'dataset' | 'live') => {
  setSidebarStateState(value);
};

export const [hasVideoMenu, setHasVideoMenu] = hasVideoMenuSig!;






