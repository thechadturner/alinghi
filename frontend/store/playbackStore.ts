import { createSyncSignal, clearSyncData } from '@solidjs/sync';
import { warn, debug } from '../utils/console';
import { createEffect, onCleanup, createRoot, untrack, createSignal } from 'solid-js';
import { selectedEvents, selectedRange, setSelectedRange } from './selectionStore';
import { apiEndpoints } from '@config/env';
import { getData } from '../utils/global';
import { liveConfigStore } from './liveConfigStore';
import { liveSourcesStore } from './liveSourcesStore';
import { streamingStore } from './streamingStore';

// Type definitions
export interface PlaybackState {
  showPlayback: boolean;
  selectedTime: Date;
  isPlaying: boolean;
  playbackSpeed: number;
  timeWindow: number; // Time window in minutes
  videoTime: Date | null;
  playbackInterval: number | null;
  isManualTimeChange: boolean; // Flag to track manual time changes (brush, track click)
  activeComponent: string | null; // Track which component is currently controlling selectedTime
}

export type SyncFunction = () => void;

/** Seconds to add to maneuver datetime to get video clip start. Negative = start before maneuver time. */
export const MANEUVER_VIDEO_START_OFFSET_SECONDS = -15;

// Helper function to safely call sync functions and handle BroadcastChannel errors
const safeSync = (syncFn: (() => void) | undefined, name: string = 'sync'): void => {
  if (typeof syncFn === "function") {
    try {
      syncFn();
    } catch (error: any) {
      // BroadcastChannel might be closed (e.g., during page unload or tab close)
      if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
        debug(`🔄 ${name} skipped - BroadcastChannel is closed`);
      } else {
        warn(`Error in ${name}:`, error);
      }
    }
  }
};
// Safe accessor to avoid TS issues when upstream typing is too loose
const getActiveComponentName = (): string | null => {
  try {
    const val: any = activeComponent();
    return typeof val === 'string' ? val : null;
  } catch {
    return null;
  }
};

// Safe boolean getter for manual-change flag
const getIsManual = (): boolean => {
  try {
    const fn: any = isManualTimeChange as any;
    const val = typeof fn === 'function' ? fn() : fn;
    return !!val;
  } catch {
    return false;
  }
};

// Declare all signal variables first
let showPlaybackState: any;
let setShowPlaybackState: any;
let syncShowPlayback: any;
let selectedTimeState: any;
let setSelectedTimeState: any;
let syncSelectedTime: any;
let isPlayingState: any;
let setIsPlayingState: any;
let syncIsPlaying: any;
let playbackSpeedState: any;
let setPlaybackSpeedState: any;
let syncPlaybackSpeed: any;
let timeWindowState: any;
let setTimeWindowState: any;
let syncTimeWindow: any;
let videoTimeState: any;
let setVideoTimeState: any;
let syncVideoTime: any;
let playbackIntervalState: any;
let setPlaybackIntervalState: any;
let isManualTimeChangeState: any;
let setIsManualTimeChangeState: any;
let syncIsManualTimeChange: any;
let shouldRestartPlaybackState: any;
let setShouldRestartPlaybackState: any;
let activeComponentState: any;
let setActiveComponentState: any;
let syncActiveComponent: any;
let liveModeState: any;
let setLiveModeState: any;
// Initialize all signals within a createRoot to avoid cleanup warnings
createRoot(() => {
  [showPlaybackState, setShowPlaybackState, syncShowPlayback] = createSyncSignal(true, {
    key: "showPlayback",
    autoSync: true
  });
  [selectedTimeState, setSelectedTimeState, syncSelectedTime] = createSyncSignal(new Date('1970-01-01T12:00:00Z'), {
    key: "selectedTime",
    autoSync: true
  });
  [isPlayingState, setIsPlayingState, syncIsPlaying] = createSyncSignal(false, {
    key: "isPlaying",
    autoSync: true
  });
  [playbackSpeedState, setPlaybackSpeedState, syncPlaybackSpeed] = createSyncSignal(1, {
    key: "playbackSpeed",
    autoSync: true
  });
  [timeWindowState, setTimeWindowState, syncTimeWindow] = createSyncSignal(0, {
    key: "timeWindow",
    autoSync: true
  });
  [videoTimeState, setVideoTimeState, syncVideoTime] = createSyncSignal(null, {
    key: "videoTime",
    autoSync: true
  });
  [playbackIntervalState, setPlaybackIntervalState] = createSyncSignal(null, {
    key: "playbackInterval",
    autoSync: false // No need to sync intervals across clients
  });
  [isManualTimeChangeState, setIsManualTimeChangeState, syncIsManualTimeChange] = createSyncSignal<boolean>(false, {
    key: "isManualTimeChange",
    autoSync: true
  });
  [shouldRestartPlaybackState, setShouldRestartPlaybackState] = createSyncSignal<boolean>(false, {
    key: "shouldRestartPlayback",
    autoSync: true
  });
  [activeComponentState, setActiveComponentState, syncActiveComponent] = createSyncSignal<string | null>(null, {
    key: "activeComponent",
    autoSync: true
  });
  [liveModeState, setLiveModeState] = createSyncSignal<boolean>(false, {
    key: "liveMode",
    autoSync: true
  });
});

// Smooth playback time: advances continuously between selectedTime steps (rAF) when playing
const [smoothPlaybackTimeState, setSmoothPlaybackTimeState] = createSignal<Date>(new Date('1970-01-01T12:00:00Z'));
// Throttled copy for track/wind/bad air (~10fps) to avoid heavy recompute every frame
const TRACK_THROTTLE_MS = 100;
const [smoothPlaybackTimeForTrackState, setSmoothPlaybackTimeForTrackState] = createSignal<Date>(new Date('1970-01-01T12:00:00Z'));
let lastTrackUpdateMs = 0;
// Throttled copy for boat (~30fps) - fewer updates + short transition = smooth and lighter CPU
const BOAT_THROTTLE_MS = 33;
const [smoothPlaybackTimeForBoatState, setSmoothPlaybackTimeForBoatState] = createSignal<Date>(new Date('1970-01-01T12:00:00Z'));
let lastBoatUpdateMs = 0;

let smoothRafId: number | null = null;
let lastAnchorTimeMs = 0;
let lastAnchorRealMs = 0;
let _pollingIntervalMs = 1000;
let prevSelectedTimeMs = 0;
/** Last smooth time we set; used to avoid boats/tracks jumping backwards when selectedTime syncs to an older value. */
let lastSmoothTimeMs = 0;
/** Throttle debug logging for time-window / smooth playback (every 500ms). */
let lastDisplayWindowDebugLog = 0;
let lastSmoothTickDebugLog = 0;

// When maneuver video reset is pressed, increment so chart Video tiles seek back to their fixedStartTime
const [maneuverVideoResetTriggerState, setManeuverVideoResetTriggerState] = createSignal(0);
export const maneuverVideoResetTrigger = maneuverVideoResetTriggerState;
export const setManeuverVideoResetTrigger = (fn: (prev: number) => number) => setManeuverVideoResetTriggerState(fn);

// Configurable maneuver video start offset (seconds before maneuver time). Default -15; user can adjust via step controls when at init time.
const [maneuverVideoStartOffsetSecondsState, setManeuverVideoStartOffsetSecondsState] = createSignal(MANEUVER_VIDEO_START_OFFSET_SECONDS);
export const maneuverVideoStartOffsetSeconds = maneuverVideoStartOffsetSecondsState;
export const setManeuverVideoStartOffsetSeconds = (value: number | ((prev: number) => number)) => {
  if (typeof value === 'function') {
    setManeuverVideoStartOffsetSecondsState(value);
  } else {
    setManeuverVideoStartOffsetSecondsState(() => value);
  }
};

function smoothPlaybackTick(): void {
  const playing = isPlayingState();
  if (!playing) {
    smoothRafId = null;
    return;
  }
  const now = Date.now();
  const current = selectedTime();
  const currentMs = current instanceof Date ? current.getTime() : 0;
  if (currentMs === 0) {
    smoothRafId = requestAnimationFrame(smoothPlaybackTick);
    return;
  }
  if (prevSelectedTimeMs !== currentMs) {
    lastAnchorTimeMs = prevSelectedTimeMs || currentMs;
    lastAnchorRealMs = now;
    prevSelectedTimeMs = currentMs;
  }
  const elapsed = now - lastAnchorRealMs;
  const speed = typeof playbackSpeedState() === "number" && playbackSpeedState() > 0 ? playbackSpeedState() : 1;
  // Advance by elapsed real time × speed; cap at authoritative selectedTime
  const candidateMs = Math.min(
    currentMs,
    lastAnchorTimeMs + elapsed * speed
  );
  // Never move smooth time backwards (e.g. when selectedTime syncs from another tab or Redis refetch)
  const smoothMs = candidateMs >= lastSmoothTimeMs ? candidateMs : lastSmoothTimeMs;
  lastSmoothTimeMs = smoothMs;
  setSmoothPlaybackTimeState(new Date(smoothMs));
  // Throttle updates for track/wind/bad air so they don't recompute 60 times/sec
  if (now - lastTrackUpdateMs >= TRACK_THROTTLE_MS) {
    lastTrackUpdateMs = now;
    setSmoothPlaybackTimeForTrackState(new Date(smoothMs));
    if (now - lastSmoothTickDebugLog >= 500) {
      lastSmoothTickDebugLog = now;
      debug('⏰ PlaybackStore smoothPlaybackTick: track time updated', {
        smoothMs: new Date(smoothMs).toISOString(),
        selectedTimeMs: currentMs,
        speed: typeof playbackSpeedState() === 'number' ? playbackSpeedState() : 1
      });
    }
  }
  // Throttle boat updates (~30fps); short transition fills in gaps for smooth look
  if (now - lastBoatUpdateMs >= BOAT_THROTTLE_MS) {
    lastBoatUpdateMs = now;
    setSmoothPlaybackTimeForBoatState(new Date(smoothMs));
  }
  smoothRafId = requestAnimationFrame(smoothPlaybackTick);
}

function startSmoothPlayback(): void {
  const t = selectedTime();
  const ms = t instanceof Date ? t.getTime() : 0;
  if (ms > 0) {
    // Start from current time so playback resumes from where the user was (no 1s jump).
    lastAnchorTimeMs = ms;
    prevSelectedTimeMs = ms;
    lastSmoothTimeMs = ms;
    const date = new Date(ms);
    setSmoothPlaybackTimeState(date);
    setSmoothPlaybackTimeForTrackState(date);
    setSmoothPlaybackTimeForBoatState(date);
  }
  lastAnchorRealMs = Date.now();
  lastTrackUpdateMs = 0;
  lastBoatUpdateMs = 0;
  if (smoothRafId != null) cancelAnimationFrame(smoothRafId);
  smoothRafId = requestAnimationFrame(smoothPlaybackTick);
}

function stopSmoothPlayback(): void {
  if (smoothRafId != null) {
    cancelAnimationFrame(smoothRafId);
    smoothRafId = null;
  }
  const t = selectedTime();
  const date = t instanceof Date ? t : new Date('1970-01-01T12:00:00Z');
  lastSmoothTimeMs = date.getTime();
  setSmoothPlaybackTimeState(date);
  setSmoothPlaybackTimeForTrackState(date);
  setSmoothPlaybackTimeForBoatState(date);
}

export function smoothPlaybackTime(): Date {
  if (!isPlayingState()) return selectedTime();
  const t = smoothPlaybackTimeState();
  return t instanceof Date && !isNaN(t.getTime()) ? t : selectedTime();
}

/** Throttled (~10fps) for track, wind, bad air - use this in MapContainer effectivePlaybackTime to avoid 60fps recompute. */
export function smoothPlaybackTimeForTrack(): Date {
  if (!isPlayingState()) return selectedTime();
  const t = smoothPlaybackTimeForTrackState();
  return t instanceof Date && !isNaN(t.getTime()) ? t : selectedTime();
}

/** Throttled (~30fps) for boat - use with short transition for smooth movement and lower CPU. */
export function smoothPlaybackTimeForBoat(): Date {
  if (!isPlayingState()) return selectedTime();
  const t = smoothPlaybackTimeForBoatState();
  return t instanceof Date && !isNaN(t.getTime()) ? t : selectedTime();
}

// Note: We'll add logging in the selectedTime getter instead to avoid createEffect issues

export const selectedTime = () => {
  const time = selectedTimeState() as any;
  
  // Handle both Date objects and string values (from cross-window sync)
  let dateTime: Date;
  
  if (time instanceof Date && !isNaN(time.getTime())) {
    dateTime = time;
  } else if (typeof time === 'string' && time) {
    // Convert string to Date (from cross-window sync)
    dateTime = new Date(time);
    if (isNaN(dateTime.getTime())) {
      debug(`🔄 selectedTime: Invalid string date, using default:`, time);
      dateTime = new Date('1970-01-01T12:00:00Z');
    }
    // Only log conversion if it's not a frequent repeated value (reduce noise)
    // Removed excessive logging for normal string-to-Date conversions
  } else {
    debug(`🔄 selectedTime: Invalid time value, using default:`, { time, type: typeof time });
    dateTime = new Date('1970-01-01T12:00:00Z');
  }
  
  // Only log when selectedTime is accessed and it's the default value (reduce noise)
  // Removed default value logging as it's too verbose
  
  return dateTime;
};

// Add throttling for selectedTime updates
let lastSelectedTimeSync: number = 0;
let lastSelectedTimeValue: Date | null = null;

export const setSelectedTime = (value: Date, requestingComponent?: string, force?: boolean) => {
  if (value instanceof Date) {
    // Reject invalid dates (e.g. from scale.invert() when chart is not yet laid out or in small/split view)
    const timeMs = value.getTime();
    if (!Number.isFinite(timeMs)) {
      debug(`⏰ setSelectedTime: Ignoring invalid date (e.g. from invert in small/split view)`, { requestingComponent });
      return;
    }
    // During playback, only the playback store may set selectedTime (single source of truth)
    if (isPlayingState() && requestingComponent !== undefined && requestingComponent !== 'playback') {
      return;
    }
    // Check if component has permission to set selectedTime
    const currentActiveName = getActiveComponentName();
    if (requestingComponent && currentActiveName && currentActiveName !== requestingComponent) {
      const currentPriority = COMPONENT_PRIORITIES[currentActiveName] || 0;
      const requestedPriority = COMPONENT_PRIORITIES[requestingComponent] || 0;
      
      if (requestedPriority < currentPriority) {
        debug(`🚫 setSelectedTime denied for '${requestingComponent}' - '${activeComponent()}' has higher priority (${currentPriority} > ${requestedPriority})`);
        return;
      }
      
      // If user interaction takes control from playback, pause playback
      if (currentActiveName === 'playback' && (requestingComponent === 'maptimeseries' || requestingComponent === 'timeseries' || requestingComponent === 'map')) {
        debug(`⏸️ User interaction taking control from playback - pausing playback`);
        setIsPlaying(false);
        clearPlaybackInterval();
        // Do NOT auto-restart playback after manual time change
      }
      
      // Also pause playback if this is a manual time change (regardless of component)
      if (currentActiveName === 'playback' && requestingComponent && requestingComponent !== 'playback') {
        debug(`⏸️ Manual time change detected - pausing playback`);
        setIsPlaying(false);
        clearPlaybackInterval();
        // Do NOT auto-restart playback after manual time change
      }
    }
    
    const defaultTime = new Date('1970-01-01T12:00:00Z');
    const _isDefaultTime = value.getTime() === defaultTime.getTime();
    
    // Only log setSelectedTime for non-playback components or significant changes
    if (requestingComponent && requestingComponent !== 'playback') {
      debug(`⏰ setSelectedTime by '${requestingComponent}':`, value.toISOString());
    }
    
    if (!force && lastSelectedTimeValue && Math.abs(value.getTime() - lastSelectedTimeValue.getTime()) < 20) {
      return; // Skip if time hasn't changed significantly (reduced to 20ms for very smooth animation)
    }

    if (requestingComponent === 'playback' && lastSelectedTimeValue) {
      lastAnchorTimeMs = lastSelectedTimeValue.getTime();
      lastAnchorRealMs = Date.now();
    }

    // When user clicks to set time on map/timeseries, pause playback so all windows stay in sync
    const manualTimeComponents = ['maptimeseries', 'timeseries', 'multimaptimeseries', 'livemaptimeseries', 'map'];
    if (requestingComponent && requestingComponent !== 'playback' && manualTimeComponents.includes(requestingComponent) && isPlayingState()) {
      setIsPlayingState(false);
      safeSync(syncIsPlaying, 'syncIsPlaying');
    }

    setSelectedTimeState(value);
    lastSelectedTimeValue = value;

    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('playbackSelectedTimeChange', { detail: { selectedTime: value } }));
      }
    } catch (_) {}

    // Reset manual change flag after a short delay to allow components to react
    setTimeout(() => {
      setIsManualTimeChange(false);
    }, 50);
    
    // Do not auto-restart playback after manual time changes
    
    // Much more aggressive throttling for sync calls
    const now = Date.now();
    if (now - lastSelectedTimeSync > 500) { // Only sync every 500ms
      lastSelectedTimeSync = now;
      if (typeof syncSelectedTime === "function") {
        safeSync(syncSelectedTime, 'syncSelectedTime');
        // Removed frequent sync log - only syncs every 500ms anyway
      }
    }
    
    // Broadcast to parent window for cross-window sync
    try {
      if (typeof window !== 'undefined' && window.opener && !window.opener.closed) {
        debug(`📡 Broadcasting selectedTime to parent window:`, value.toISOString());
        window.opener.postMessage({
          type: 'PLAYBACK_UPDATE_FROM_CHILD',
          payload: {
            type: 'TIME_CHANGE',
            selectedTime: value.toISOString(),
            requestingComponent
          },
          windowName: window.name
        }, window.location.origin);
      }
    } catch (error) {
      warn('Error broadcasting selectedTime update:', error);
    }
  } else {
    warn("Invalid value for selectedTime. Expected a Date object.", value);
  }
};

// Export the sync function for manual synchronization
export const syncSelectedTimeManual: SyncFunction = () => {
  safeSync(syncSelectedTime, 'syncSelectedTime');
};

// Force sync all playback signals when needed
export const forceSyncAll = () => {
  debug('⏰ PlaybackStore: Force syncing all signals');
  safeSync(syncSelectedTime, 'syncSelectedTime');
  safeSync(syncIsPlaying, 'syncIsPlaying');
  safeSync(syncPlaybackSpeed, 'syncPlaybackSpeed');
  safeSync(syncTimeWindow, 'syncTimeWindow');
  safeSync(syncShowPlayback, 'syncShowPlayback');
  safeSync(syncVideoTime, 'syncVideoTime');
  safeSync(syncIsManualTimeChange, 'syncIsManualTimeChange');
};

// Auto-hide timewindow and set to zero when selections are made
let lastSelectionState = false;
let selectionEffectInitialized = false;
let selectionEffectDispose: (() => void) | null = null;

export const initializeSelectionEffect = () => {
  if (selectionEffectInitialized) return;
  selectionEffectInitialized = true;
  
  if (selectionEffectDispose) {
    selectionEffectDispose();
  }
  
  selectionEffectDispose = createRoot((dispose) => {
    createEffect(() => {
      try {
        // Check if there are active selections
        const hasSelections = selectedEvents().length > 0 || selectedRange().length > 0;
        
        // Only update if the selection state has actually changed
        if (hasSelections !== lastSelectionState) {
          lastSelectionState = hasSelections;
          
          if (hasSelections) {
            setShowPlayback(false);
            setTimeWindow(0); // Set timewindow to zero
          } else {
            // Restore timewindow when no selections
            setShowPlayback(true);
            // Don't restore timewindow value - let user set it manually
          }
        }
      } catch (error) {
        // Ignore errors if selection store is not available
      }
    });
    
    return dispose;
  });
};

export const isPlaying = () => {
  const playing = isPlayingState();
  return typeof playing === "boolean" ? playing : false;
};

// Add a guard to prevent rapid toggling
let lastSetIsPlayingTime = 0;
const MIN_SET_INTERVAL = 50; // Minimum 50ms between setIsPlaying calls

export const setIsPlaying = (value: boolean) => {
  const now = Date.now();
  const timeSinceLastCall = now - lastSetIsPlayingTime;
  
  // Prevent rapid toggling for play; always allow pause so cross-window sync is reliable
  if (value === true && timeSinceLastCall < MIN_SET_INTERVAL) {
    debug(`[PlaybackStore] Throttling setIsPlaying call (${timeSinceLastCall}ms since last call)`);
    return;
  }
  
  lastSetIsPlayingTime = now;

  // Clear brush when play is pressed, but not when event-based selection is active (e.g. single-source Maneuvers VIDEO with rows selected).
  // In split view, do NOT clear brush on play: the other panel (e.g. maneuvers) may trigger play/sync and would wipe the map panel's timeseries brush selection.
  const inSplitView = typeof document !== 'undefined' && document.querySelector('.split-view-content') != null;
  if (value === true && selectedEvents().length === 0 && !inSplitView) {
    setSelectedRange([]);
    // Also clear the visual brush on the timeseries chart
    if (typeof window !== 'undefined') {
      if (window.clearMapBrush) {
        try {
          window.clearMapBrush();
        } catch (err) {
          debug(`[PlaybackStore] Error clearing map brush:`, err);
        }
      }
      if (window.clearTimeSeriesBrush) {
        try {
          window.clearTimeSeriesBrush();
        } catch (err) {
          debug(`[PlaybackStore] Error clearing timeseries brush:`, err);
        }
      }
    }
  }
  
  setIsPlayingState(value);
  
  // Immediate sync like in the example
  safeSync(syncIsPlaying, 'syncIsPlaying');

  // Notify parent so it can forward to other child windows (cross-window pause/play sync)
  try {
    if (typeof window !== 'undefined' && window.opener && !window.opener.closed) {
      window.opener.postMessage({
        type: 'PLAYBACK_UPDATE_FROM_CHILD',
        payload: { type: 'IS_PLAYING_CHANGE', isPlaying: value },
        windowName: window.name
      }, window.location.origin);
    }
  } catch (err) {
    warn('Error broadcasting isPlaying to parent window:', err);
  }

  if (value === true) {
    // Clear manual time change flag so the manual-time-change effect doesn't immediately pause
    // (e.g. user clicked timeline earlier then pressed play — playback should stay playing)
    setIsManualTimeChange(false);

    // If a manual component currently holds control but no manual interaction is active,
    // release it so playback can take over smoothly
    const currentActive = getActiveComponentName();
    if (currentActive && (currentActive === 'map' || currentActive === 'timeseries' || currentActive === 'maptimeseries')) {
      try {
        if (!getIsManual()) {
          debug(`[PlaybackStore] Releasing manual component '${currentActive}' before starting playback`);
          releaseTimeControl(currentActive);
        }
      } catch (e) {
        // ignore
      }
    }
    // Interval start/stop is handled only by initializeIsPlayingFollowEffect to avoid double-call and races.
  }
};

// (moved watcher below, after playbackInterval signal initialization)

export const playbackSpeed = () => {
  const speed = playbackSpeedState();
  return typeof speed === "number" ? speed : 1; // Default to normal speed
};

export const setPlaybackSpeed = (value: number) => {
  setPlaybackSpeedState(Math.round(value));
  // Immediate sync
  safeSync(syncPlaybackSpeed, 'syncPlaybackSpeed');
  // Apply new speed immediately if currently playing, without relying on a root-less effect
  const speed = playbackSpeed();
  if (typeof speed === 'number' && speed > 0 && isPlaying()) {
    clearPlaybackInterval();
    startPlaybackInterval();
  }
};

export const timeWindow = () => {
  const window = timeWindowState();
  // Coerce to number (sync may return string from storage); treat invalid as 0 = full window
  let value = Number(window);
  if (!Number.isFinite(value) || value < 0) value = 0;

  // In live mode, cap the time window at 30 minutes (even if stored value is higher)
  // Use untrack to prevent reactive loops - we only want to cap based on current liveMode state
  if (untrack(() => liveMode()) && value > 30) {
    value = 30;
  }

  return value;
};

/**
 * Single source of truth for the reference time used for time-window display.
 * When playing, use smooth time so chart and map stay in sync; when paused use selectedTime.
 */
export const getDisplayWindowReferenceTime = (): Date | null => {
  const res = isPlayingState()
    ? (() => {
        const t = smoothPlaybackTimeForTrackState();
        return t instanceof Date && !isNaN(t.getTime()) ? t : selectedTime();
      })()
    : selectedTime();
  const now = Date.now();
  if (now - lastDisplayWindowDebugLog >= 500) {
    lastDisplayWindowDebugLog = now;
    debug('⏰ PlaybackStore getDisplayWindowReferenceTime', {
      playing: isPlayingState(),
      ref: res instanceof Date ? res.toISOString() : null
    });
  }
  return res;
};

export const setTimeWindow = (value: number) => {
  // Round to 1 decimal place to preserve 0.5 (30 seconds) while handling floating point precision
  let finalValue = Math.round(value * 10) / 10;
  
  // In live mode, cap the time window at 30 minutes
  // Use untrack to prevent reactive loops
  if (untrack(() => liveMode()) && finalValue > 30) {
    finalValue = 30;
  }
  
  setTimeWindowState(finalValue);
  // Immediate sync
  safeSync(syncTimeWindow, 'syncTimeWindow');
};

export const videoTime = () => {
  const time = videoTimeState() as any;
  return time instanceof Date ? time : null;
};

export const setVideoTime = (value: Date | null) => {
  if (value instanceof Date || value === null) {
    setVideoTimeState(value);
    safeSync(syncVideoTime, 'syncVideoTime');
  } else {
    warn("Invalid value for videoTime. Expected a Date object or null.", value);
  }
};

// Export the sync function for manual synchronization
export const syncVideoTimeManual: SyncFunction = () => {
  safeSync(syncVideoTime, 'syncVideoTime');
};

export const playbackInterval = () => {
  const interval = playbackIntervalState();
  return typeof interval === "number" ? interval : null; // Ensure a number or null
};

export const setPlaybackInterval = (value: number | null) => {
  if (value !== null && typeof value !== "number") {
    warn("Invalid interval ID. Expected a number or null, received:", value);
    return; // Reject invalid values
  }
  setPlaybackIntervalState(value);
};

// Ensure playback interval follows isPlaying even when updated via cross-window sync
// Create this effect lazily from a component root to avoid disposal warnings
let isPlayingFollowEffectInitialized = false;
let isPlayingFollowEffectDispose: (() => void) | null = null;
export const initializeIsPlayingFollowEffect = () => {
  if (isPlayingFollowEffectInitialized) return;
  isPlayingFollowEffectInitialized = true;
  
  if (isPlayingFollowEffectDispose) {
    isPlayingFollowEffectDispose();
  }
  
  isPlayingFollowEffectDispose = createRoot((dispose) => {
    let lastObservedPlaying: boolean | null = null;
    createEffect(() => {
      const playing = isPlaying();
      if (playing === lastObservedPlaying) return;
      lastObservedPlaying = playing;
      if (playing) {
        startPlaybackInterval();
      } else {
        clearPlaybackInterval();
      }
    });
    
    return dispose;
  });
};

export const isManualTimeChange = isManualTimeChangeState;
export const setIsManualTimeChange = (value: boolean) => {
  // Only log when value changes
  if (isManualTimeChangeState() !== value) {
    debug('setIsManualTimeChange:', value);
  }
  setIsManualTimeChangeState(value);
  safeSync(syncIsManualTimeChange, 'syncIsManualTimeChange');
};

export const shouldRestartPlayback = shouldRestartPlaybackState;
export const setShouldRestartPlayback = (value: boolean) => {
  setShouldRestartPlaybackState(value);
};

// Playback-related signals
export const showPlayback = () => showPlaybackState() ?? true;

export const setShowPlayback = (value: boolean) => {
  setShowPlaybackState(value);
  // Ensure sync after state change
  setTimeout(() => safeSync(syncShowPlayback, 'syncShowPlayback'), 0);
};

export const activeComponent = () => activeComponentState();
export const setActiveComponent = (component: string | null) => {
  // Avoid redundant updates that can cause cross-window sync loops
  try {
    const current = (activeComponentState() as unknown) as string | null;
    if (current === component) {
      return;
    }
  } catch {
    // ignore getter errors and proceed with set
  }
  setActiveComponentState(component);
  safeSync(syncActiveComponent, 'syncActiveComponent');
};

export const liveMode = () => liveModeState() ?? false;
const DEFAULT_EPOCH_TIME = new Date('1970-01-01T12:00:00Z').getTime();
export const setLiveMode = (value: boolean) => {
  setLiveModeState(value);
  // When entering live mode, set time to now (UTC) if still at default/uninitialized
  if (value) {
    const current = selectedTime();
    if (!current || current.getTime() === DEFAULT_EPOCH_TIME || current.getTime() < Date.now() - 24 * 60 * 60 * 1000) {
      setSelectedTimeState(new Date());
      debug('⏰ PlaybackStore: Live mode on - set selectedTime to now (UTC)');
    }
  }
};

// Component priority system - higher number = higher priority
const COMPONENT_PRIORITIES: Record<string, number> = {
  'playback': 2,        // Playback system has lower priority to allow user interactions
  'map': 3,
  'timeseries': 4,      // User interactions have highest priority
  'maptimeseries': 4,   // User interactions have highest priority
  'multimaptimeseries': 4, // Multi-map time series user interactions have highest priority
  'videosync': 4,       // VideoSync timeline interactions have highest priority
  'events': 4,          // Events table user interactions have highest priority
  'video': 0,           // Video is now passive (overlay is completely passive, no priority needed)
  'maneuvers-video': 4  // Maneuvers video view can set time when user selects an event
};

// Request control of selectedTime - returns true if granted, false if denied
export const requestTimeControl = (component: string): boolean => {
  const currentActive = getActiveComponentName();
  const currentPriority = currentActive ? COMPONENT_PRIORITIES[currentActive] || 0 : 0;
  const requestedPriority = COMPONENT_PRIORITIES[component] || 0;
  
  // Simplified priority log - only show key info
  if (!currentActive || requestedPriority >= currentPriority) {
    // Only log when control is granted or denied, not every request
  }
  
  // Special handling: allow playback to reclaim control when there is no active manual interaction
  if (component === 'playback' && currentActive && (currentActive === 'map' || currentActive === 'timeseries' || currentActive === 'maptimeseries')) {
    try {
      if (!getIsManual()) {
        debug(`[PlaybackStore] Granting playback control over '${currentActive}' since no manual interaction is active`);
        setActiveComponent('playback');
        debug(`✅ Component 'playback' granted time control (preempt, no manual activity)`);
        return true;
      }
    } catch (e) {
      // fall through to normal priority logic
    }
  }

  // If requester already holds control, no work needed
  if (currentActive === component) {
    return true;
  }

  if (!currentActive || requestedPriority >= currentPriority) {
    setActiveComponent(component);
    // Only log when control changes hands
    if (currentActive) {
      debug(`✅ ${component} took control from ${currentActive}`);
    }
    return true;
  } else {
    // Only log denials for non-playback components
    if (component !== 'playback') {
      debug(`❌ ${component} denied (priority ${requestedPriority} < ${currentPriority})`);
    }
    return false;
  }
};

// Release control of selectedTime
export const releaseTimeControl = (component: string) => {
  if (getActiveComponentName() === component) {
    setActiveComponent(null);
  }
};

// Force release of time control (useful for cleanup)
export const forceReleaseTimeControl = () => {
  const currentActive = getActiveComponentName();
  if (currentActive) {
    debug(`Force releasing time control from '${currentActive}'`);
    setActiveComponent(null);
  }
};

// Check if a component should have time control based on visibility/mounting
export const validateTimeControl = () => {
  const currentActive = getActiveComponentName();
  if (!currentActive) return;
  
  // Check if the active component is still mounted/visible
  // This is a basic check - components should call this periodically
  debug(`Validating time control for '${currentActive}'`);
  
  // For now, we'll rely on components to properly release control
  // In the future, we could add more sophisticated checks here
};

// Guard to prevent multiple simultaneous source fetches
let _isFetchingSources = false;
let _lastSourceFetchAttempt = 0;
const _SOURCE_FETCH_THROTTLE_MS = 10000; // Only try to fetch sources once every 10 seconds

// Throttle "No new data available" log messages
let _lastNoDataLogTime = 0;
const _NO_DATA_LOG_THROTTLE_MS = 5000; // Only log "No new data available" once every 5 seconds

// Live mode: throttle status API fetch to pollIntervalMs
let lastLiveStatusFetchTime = 0;
let cachedLatestTimestamp: number | null = null;

// Live mode: throttle Redis playback-window pull (fill gaps when WebSocket is intermittent)
const PLAYBACK_PULL_INTERVAL_MS = 2000;
let lastPlaybackPullTime = 0;

// Helper functions to manage the interval
export function startPlaybackInterval(): void {
  clearPlaybackInterval();

  // Request control for playback system
  if (!requestTimeControl('playback')) {
    debug(`[PlaybackStore] Failed to get time control for playback, scheduling retry`);
    schedulePlaybackRetry();
    return;
  }

  // Non-live: fixed 100ms tick; step = 0.1s * speed so 1 real second advances 'speed' seconds of data (2x → 2s, 3x → 3s).
  const frequencyAnalysis = (window as any).mapFrequencyAnalysis;
  const baseInterval = liveMode() && frequencyAnalysis?.averageInterval
    ? frequencyAnalysis.averageInterval
    : 100; // 100ms tick interval (same at all speeds)
  const pollingInterval = liveMode()
    ? Math.max(50, baseInterval / Math.max(1, playbackSpeed()))
    : baseInterval; // Non-live: fixed interval; live: scale if needed
  _pollingIntervalMs = pollingInterval;

  startSmoothPlayback();

  const newInterval = setInterval(async () => {
    const currentTime = selectedTime();
    const speed = playbackSpeed();
    const isLiveMode = liveMode();

    if (currentTime instanceof Date && typeof speed === "number" && speed > 0) {
      if (isLiveMode) {
        // Live mode: run bufferMs behind real time, advance with local 1 Hz timer for smooth playback
        const bufferMsVal = liveConfigStore.bufferMs();
        const pollIntervalMsVal = liveConfigStore.pollIntervalMs();
        const now = Date.now();
        const displayTimeMs = now - bufferMsVal; // Target time we want to show (smooth buffer)

        // Throttle status API fetch to pollIntervalMs (e.g. every 5s)
        if (now - lastLiveStatusFetchTime >= pollIntervalMsVal) {
          lastLiveStatusFetchTime = now;
          try {
            const streamResponse = await getData(apiEndpoints.stream.sources);
            if (streamResponse.success && Array.isArray(streamResponse.data)) {
              const sourceNames = streamResponse.data
                .map((s: any) => s.source_name)
                .filter((name: string) => name);
              let latestTimestamp: number | null = null;
              for (const sourceName of sourceNames) {
                try {
                  const statusResponse = await getData(apiEndpoints.stream.sourceStatus(sourceName));
                  if (statusResponse.success && statusResponse.data?.latest_timestamp) {
                    const ts = statusResponse.data.latest_timestamp;
                    if (ts && (!latestTimestamp || ts > latestTimestamp)) {
                      latestTimestamp = ts;
                    }
                  }
                } catch {
                  // Skip this source
                }
              }
              cachedLatestTimestamp = latestTimestamp;
            }
          } catch (err) {
            debug(`[PlaybackStore] Live mode: status fetch error`, err);
          }
        }

        // Use cached latest for end-of-data and auto-resume checks
        const latestTimeMs = cachedLatestTimestamp ?? 0;
        const currentTimeMs = currentTime.getTime();
        const timeDiff = latestTimeMs - currentTimeMs;

        if (cachedLatestTimestamp != null) {
          if (speed >= 5 && timeDiff <= (speed * 1000)) {
            debug(`[PlaybackStore] Live mode: Reached end of data at ${speed}x speed, reducing to 1x`);
            setPlaybackSpeed(1);
          }
          const RESUME_THRESHOLD_MS = 2000;
          if (!isPlaying() && timeDiff <= RESUME_THRESHOLD_MS && timeDiff >= 0) {
            if (isManualTimeChange()) {
              setIsManualTimeChange(false);
            }
            if (!isManualTimeChange()) {
              debug(`[PlaybackStore] Live mode: Time near end, auto-resuming playback`);
              setIsPlaying(true);
            }
          }
        }

        // Advance selectedTime toward displayTime at 1 Hz (smooth, buffer-based)
        if (isPlaying() && currentTimeMs < displayTimeMs) {
          const stepMs = 1000; // 1 Hz
          const newTimeMs = Math.min(currentTimeMs + stepMs, displayTimeMs);
          setSelectedTime(new Date(newTimeMs), 'playback');
        }

        // Pull playback window from Redis periodically so we have data even when WebSocket misses pushes
        if (now - lastPlaybackPullTime >= PLAYBACK_PULL_INTERVAL_MS) {
          lastPlaybackPullTime = now;
          const sourceIds = liveSourcesStore.selectedSourceIds();
          if (sourceIds.size > 0 && streamingStore.isInitialized) {
            const windowMin = timeWindow();
            const beforeMs = windowMin > 0 ? Math.max(10000, windowMin * 60 * 1000) : 60000;
            streamingStore.pullPlaybackWindowFromRedis(sourceIds, currentTimeMs, beforeMs).catch(() => {});
          }
        }
      } else {
        // Non-live: fixed 100ms tick. Step = 0.1s * speed so that 1 real second advances 'speed' seconds of data:
        // 2x = 2 seconds of movement per 1 second, 3x = 3 seconds per 1 second, etc.
        const stepMs = 100 * Math.max(1, speed); // 100ms at 1x, 200ms at 2x, 300ms at 3x...
        const newTime = new Date(currentTime.getTime() + stepMs);
        setSelectedTime(newTime, 'playback');
      }
    }
  }, pollingInterval);

  if (typeof newInterval === "number") {
    // Removed interval ID log - not useful
    setPlaybackInterval(newInterval);
  }
}

export function clearPlaybackInterval(): void {
  stopSmoothPlayback();
  const intervalId = playbackInterval();
  if (intervalId !== null && typeof intervalId === "number") {
    clearInterval(intervalId);
    setPlaybackInterval(null); // Reset the interval state
  }
  // Clear any pending retry attempts
  clearPlaybackRetry();
  
  // Release control when playback stops
  releaseTimeControl('playback');
}

// Watch for manual time changes and pause playback
let manualTimeChangeEffectInitialized = false;
let manualTimeChangeEffectDispose: (() => void) | null = null;

export const initializeManualTimeChangeEffect = () => {
  if (manualTimeChangeEffectInitialized) return;
  manualTimeChangeEffectInitialized = true;
  
  if (manualTimeChangeEffectDispose) {
    manualTimeChangeEffectDispose();
  }
  
  manualTimeChangeEffectDispose = createRoot((dispose) => {
    createEffect(() => {
      const isManual = isManualTimeChange();
      if (isManual && isPlaying()) {
        debug(`⏸️ Manual time change detected - pausing playback`);
        setIsPlaying(false);
        clearPlaybackInterval();
        // Do NOT set any restart flag; resume only on explicit user action
      }
    });
    
    return dispose;
  });
};

// Retry logic for starting playback when time control is temporarily unavailable
let playbackRetryTimer: any = null;
const RETRY_DELAY_MS = 150;
const MAX_RETRY_MS = 3000;
let retryStartTime: number | null = null;

function schedulePlaybackRetry(): void {
  if (!isPlaying()) return; // Only retry if user intends to play
  if (playbackRetryTimer) return; // Already scheduled
  if (retryStartTime === null) retryStartTime = Date.now();
  const elapsed = Date.now() - retryStartTime;
  if (elapsed > MAX_RETRY_MS) {
    debug(`[PlaybackStore] Playback retry window expired after ${elapsed}ms`);
    retryStartTime = null;
    return;
  }
  playbackRetryTimer = setTimeout(() => {
    playbackRetryTimer = null;
    startPlaybackInterval();
  }, RETRY_DELAY_MS);
}

function clearPlaybackRetry(): void {
  if (playbackRetryTimer) {
    clearTimeout(playbackRetryTimer);
    playbackRetryTimer = null;
  }
  retryStartTime = null;
}

// Add a function to force sync all playback signals
export function forcePlaybackSync(): void {
  safeSync(syncSelectedTime, 'syncSelectedTime');
  safeSync(syncIsPlaying, 'syncIsPlaying');
  safeSync(syncPlaybackSpeed, 'syncPlaybackSpeed');
  safeSync(syncTimeWindow, 'syncTimeWindow');
  safeSync(syncShowPlayback, 'syncShowPlayback');
}

// Add periodic sync to ensure consistency across components
let periodicSyncInterval: any = null;

export function startPeriodicSync(): void {
  if (periodicSyncInterval) return; // Already running
  
  debug('⏰ PlaybackStore: Event-driven sync enabled (no periodic timer needed)');
  
  // Event-driven sync: Only sync when there are actual changes
  // The sync signals already have autoSync: true, so they handle cross-window sync automatically
  // We only need to ensure sync when there are specific events that might need it
  
  // Sync on window focus (in case we missed updates while tab was inactive)
  const handleWindowFocus = () => {
    if (!isPlaying()) {
      const currentTime = selectedTime();
      const defaultTime = new Date('1970-01-01T12:00:00Z');

      // In live mode: always sync to now (UTC) so playback shows current time
      if (liveMode()) {
        setSelectedTimeState(new Date());
        return;
      }

      // Only sync if current time is default (uninitialized)
      if (currentTime && currentTime.getTime() === defaultTime.getTime()) {
        syncSelectedTimeManual();
      }
    }
  };

  // Sync on visibility change (when tab becomes visible)
  const handleVisibilityChange = () => {
    if (!document.hidden && !isPlaying()) {
      const currentTime = selectedTime();
      const defaultTime = new Date('1970-01-01T12:00:00Z');

      // In live mode: always sync to now (UTC) so playback shows current time
      if (liveMode()) {
        setSelectedTimeState(new Date());
        return;
      }

      // Only sync if current time is default (uninitialized)
      if (currentTime && currentTime.getTime() === defaultTime.getTime()) {
        syncSelectedTimeManual();
      }
    }
  };
  
  // Handle cross-window playback updates
  const handleCrossWindowPlaybackUpdate = (event: CustomEvent) => {
    const payload = (event as any).detail;
    if (!payload) return;
    
    if (payload.type === 'TIME_CHANGE' && payload.selectedTime) {
      debug('🔄 PlaybackStore: Received cross-window time update', payload.selectedTime);
      const newTime = new Date(payload.selectedTime);
      if (!isNaN(newTime.getTime())) {
        // Update without broadcasting back
        setSelectedTimeState(newTime);
        lastSelectedTimeValue = newTime;
        try {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('playbackSelectedTimeChange', { detail: { selectedTime: newTime } }));
          }
        } catch (_) {}
      }
    }
    if (payload.timeWindow !== undefined && Number.isFinite(Number(payload.timeWindow))) {
      setTimeWindowState(Number(payload.timeWindow));
    }
    if (payload.isPlaying !== undefined) {
      debug('🔄 PlaybackStore: Received cross-window isPlaying update', payload.isPlaying);
      setIsPlayingState(payload.isPlaying);
      // When receiving "play" from another window, clear manual time change so the local
      // manual-time-change effect does not immediately pause (which would thrash play/pause).
      if (payload.isPlaying === true) {
        setIsManualTimeChange(false);
      }
    }
  };
  
  // Add event listeners for smarter sync
  window.addEventListener('focus', handleWindowFocus);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('playbackStoreUpdate', handleCrossWindowPlaybackUpdate as EventListener);
  
  // Store cleanup function
  periodicSyncInterval = {
    cleanup: () => {
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('playbackStoreUpdate', handleCrossWindowPlaybackUpdate as EventListener);
    }
  } as any;
}

export function stopPeriodicSync(): void {
  if (periodicSyncInterval) {
    // Handle both old interval and new event-driven cleanup
    if (typeof periodicSyncInterval === 'number') {
      clearInterval(periodicSyncInterval);
    } else if (periodicSyncInterval.cleanup) {
      periodicSyncInterval.cleanup();
    }
    periodicSyncInterval = null;
  }
}

// Cleanup function to clear all sync signals
export function disposePlaybackStore(): void {
  stopPeriodicSync();
  clearPlaybackInterval();
  
  // Dispose of effects
  if (selectionEffectDispose) {
    selectionEffectDispose();
    selectionEffectDispose = null;
    selectionEffectInitialized = false;
  }
  if (isPlayingFollowEffectDispose) {
    isPlayingFollowEffectDispose();
    isPlayingFollowEffectDispose = null;
    isPlayingFollowEffectInitialized = false;
  }
  if (manualTimeChangeEffectDispose) {
    manualTimeChangeEffectDispose();
    manualTimeChangeEffectDispose = null;
    manualTimeChangeEffectInitialized = false;
  }
  
  // Clean up all sync signals - clearSyncData now automatically triggers cleanup
  clearSyncData("showPlayback");
  clearSyncData("selectedTime");
  clearSyncData("isPlaying");
  clearSyncData("playbackSpeed");
  clearSyncData("timeWindow");
  clearSyncData("playbackInterval");
  clearSyncData("videoTime");
  clearSyncData("isManualTimeChange");
  clearSyncData("shouldRestartPlayback");
  clearSyncData("activeComponent");
  clearSyncData("liveMode");
}

// This function should be called within a component to properly register cleanup
let appCleanupDispose: (() => void) | null = null;
export function registerPlaybackStoreCleanup(): void {
  if (appCleanupDispose) {
    appCleanupDispose();
  }
  appCleanupDispose = createRoot((dispose) => {
    // Wrap onCleanup in createEffect to ensure it's called within a reactive context
    // Use untrack to prevent the effect from tracking any reactive dependencies
    createEffect(() => {
      untrack(() => {
        onCleanup(() => {
          disposePlaybackStore();
        });
      });
    });
    return dispose;
  });
}
