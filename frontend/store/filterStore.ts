/**
 * FilterStore: Centralized filter state management with cross-window synchronization
 *
 * Filters are separated by context: maneuvers, aggregates, timeseries.
 * Setting a maneuver filter (e.g. grade 1) does not affect aggregates or timeseries.
 *
 * Maneuver **selection** signals (selected*Maneuvers, maneuverTrainingRacing) use createSyncSignal with
 * autoSync: false so IndexedDB does not propagate them across tabs. The main dashboard applies changes
 * via setters; Sidebar forwards `getManeuverWindowsFilterBroadcastPayload()` to maneuver popups by postMessage.
 *
 * @module filterStore
 */

export type FilterContext = 'maneuvers' | 'aggregates' | 'timeseries';

import { createSyncSignal, clearSyncData } from '@solidjs/sync';
import { createSignal, onCleanup, createRoot, createEffect, untrack } from 'solid-js';
import { log } from '../utils/console';
import { error as logError, warn, debug } from '../utils/console';
import { batch } from 'solid-js';
import { getData } from '../utils/global';
import { apiEndpoints } from '@config/env';
import { persistantStore } from './persistantStore';
import { user } from './userStore';
import { persistentSettingsService } from '../services/persistentSettingsService';

// Cross-window sync state
let isUpdatingFromCrossWindow = false;

// Coalesced broadcast machinery
let pendingBroadcast = false;
const dirtyKeys = new Set<string>();

/**
 * Get a snapshot of all current filter values
 * @returns {Record<string, unknown>} Object containing all filter states
 */
const getFilterSnapshot = (): Record<string, unknown> => {
  try {
    const snap: Record<string, unknown> = {
      selectedStates: selectedStatesTimeseriesState ? (Array.isArray(selectedStatesTimeseriesState()) ? selectedStatesTimeseriesState() : []) : [],
      selectedRaces: selectedRacesTimeseriesState ? (Array.isArray(selectedRacesTimeseriesState()) ? selectedRacesTimeseriesState() : []) : [],
      selectedLegs: selectedLegsTimeseriesState ? (Array.isArray(selectedLegsTimeseriesState()) ? selectedLegsTimeseriesState() : []) : [],
      selectedGrades: selectedGradesTimeseriesState ? (Array.isArray(selectedGradesTimeseriesState()) ? selectedGradesTimeseriesState() : []) : [],
      selectedSources: selectedSourcesState ? (Array.isArray(selectedSourcesState()) ? selectedSourcesState() : []) : [],
      raceOptions: raceOptionsState ? (Array.isArray(raceOptionsState()) ? raceOptionsState() : []) : [],
      legOptions: legOptionsState ? (Array.isArray(legOptionsState()) ? legOptionsState() : []) : [],
      gradeOptions: gradeOptionsState ? (Array.isArray(gradeOptionsState()) ? gradeOptionsState() : []) : [],
      selectedHeadsailCodes: selectedHeadsailCodesState ? (Array.isArray(selectedHeadsailCodesState()) ? selectedHeadsailCodesState() : []) : [],
      selectedMainsailCodes: selectedMainsailCodesState ? (Array.isArray(selectedMainsailCodesState()) ? selectedMainsailCodesState() : []) : [],
      headsailCodeOptions: headsailCodeOptionsState ? (Array.isArray(headsailCodeOptionsState()) ? headsailCodeOptionsState() : []) : [],
      mainsailCodeOptions: mainsailCodeOptionsState ? (Array.isArray(mainsailCodeOptionsState()) ? mainsailCodeOptionsState() : []) : []
    };
    // Namespaced filter keys (maneuvers / aggregates / timeseries)
    if (selectedStatesManeuversState) snap.selectedStatesManeuvers = Array.isArray(selectedStatesManeuversState()) ? selectedStatesManeuversState() : [];
    if (selectedRacesManeuversState) snap.selectedRacesManeuvers = Array.isArray(selectedRacesManeuversState()) ? selectedRacesManeuversState() : [];
    if (selectedLegsManeuversState) snap.selectedLegsManeuvers = Array.isArray(selectedLegsManeuversState()) ? selectedLegsManeuversState() : [];
    if (selectedGradesManeuversState) snap.selectedGradesManeuvers = Array.isArray(selectedGradesManeuversState()) ? selectedGradesManeuversState() : [];
    if (maneuverTrainingRacingState) snap.maneuverTrainingRacing = maneuverTrainingRacingState() ?? null;
    if (maneuverTimeseriesDescriptionState) snap.maneuverTimeseriesDescription = String(maneuverTimeseriesDescriptionState() ?? 'BASICS');
    if (selectedStatesAggregatesState) snap.selectedStatesAggregates = Array.isArray(selectedStatesAggregatesState()) ? selectedStatesAggregatesState() : [];
    if (selectedRacesAggregatesState) snap.selectedRacesAggregates = Array.isArray(selectedRacesAggregatesState()) ? selectedRacesAggregatesState() : [];
    if (selectedLegsAggregatesState) snap.selectedLegsAggregates = Array.isArray(selectedLegsAggregatesState()) ? selectedLegsAggregatesState() : [];
    if (selectedGradesAggregatesState) snap.selectedGradesAggregates = Array.isArray(selectedGradesAggregatesState()) ? selectedGradesAggregatesState() : [];
    if (selectedStatesTimeseriesState) snap.selectedStatesTimeseries = Array.isArray(selectedStatesTimeseriesState()) ? selectedStatesTimeseriesState() : [];
    if (selectedRacesTimeseriesState) snap.selectedRacesTimeseries = Array.isArray(selectedRacesTimeseriesState()) ? selectedRacesTimeseriesState() : [];
    if (selectedLegsTimeseriesState) snap.selectedLegsTimeseries = Array.isArray(selectedLegsTimeseriesState()) ? selectedLegsTimeseriesState() : [];
    if (selectedGradesTimeseriesState) snap.selectedGradesTimeseries = Array.isArray(selectedGradesTimeseriesState()) ? selectedGradesTimeseriesState() : [];
    return snap;
  } catch (error) {
    logError('Error getting filter snapshot:', error);
    return {
      selectedStates: [], selectedRaces: [], selectedLegs: [], selectedGrades: [],
      selectedSources: [], raceOptions: [], legOptions: [], gradeOptions: [],
      selectedHeadsailCodes: [], selectedMainsailCodes: [], headsailCodeOptions: [], mainsailCodeOptions: [],
      selectedStatesManeuvers: [], selectedRacesManeuvers: [], selectedLegsManeuvers: [], selectedGradesManeuvers: [],
      selectedStatesAggregates: [], selectedRacesAggregates: [], selectedLegsAggregates: [], selectedGradesAggregates: [],
      selectedStatesTimeseries: [], selectedRacesTimeseries: [], selectedLegsTimeseries: [], selectedGradesTimeseries: [],
      maneuverTrainingRacing: null,
      maneuverTimeseriesDescription: 'BASICS',
    };
  }
};

/** Filter keys sent to maneuver popup windows when the main page changes filters (Sidebar postMessage). */
const MANEUVER_WINDOWS_FILTER_BROADCAST_KEYS = [
  'selectedStatesManeuvers',
  'selectedRacesManeuvers',
  'selectedLegsManeuvers',
  'selectedGradesManeuvers',
  'maneuverTrainingRacing',
  'raceOptions',
  'legOptions',
  'gradeOptions',
  'maneuverTimeseriesDescription',
] as const;

/**
 * Snapshot slice for maneuver popups: always matches main dashboard filterStore for these keys.
 * Used instead of partial dirty payloads so children never miss a field when the main page updates.
 */
export function getManeuverWindowsFilterBroadcastPayload(): Record<string, unknown> {
  const snap = getFilterSnapshot();
  const out: Record<string, unknown> = {};
  for (const k of MANEUVER_WINDOWS_FILTER_BROADCAST_KEYS) {
    if (snap[k] !== undefined) out[k] = snap[k];
  }
  return out;
}

const scheduleBroadcast = () => {
  if (pendingBroadcast || isUpdatingFromCrossWindow) return;
  pendingBroadcast = true;
  queueMicrotask(() => {
    try {
      if (typeof window !== 'undefined' && dirtyKeys.size > 0) {
        const snapshot = getFilterSnapshot();
        const payload: Record<string, unknown> = {};
        dirtyKeys.forEach((key) => {
          payload[key] = (snapshot as any)[key];
        });
        
        // Dispatch CustomEvent locally for same-window components
        window.dispatchEvent(new CustomEvent('filterStoreUpdate', { detail: payload }));
        
        // Send to parent window for cross-window sync (will be redistributed to all windows including sender)
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({ 
            type: 'FILTER_UPDATE_FROM_CHILD', 
            payload, 
            windowName: window.name 
          }, window.location.origin);
        }
      }
    } catch (error: any) {
      // BroadcastChannel might be closed (e.g., during page unload or tab close)
      if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
        debug('FilterStore: Broadcast skipped - BroadcastChannel is closed');
      } else {
        warn('FilterStore: Error broadcasting filter update:', error);
      }
    } finally {
      dirtyKeys.clear();
      pendingBroadcast = false;
    }
  });
};

const markDirtyAndBroadcast = (key: string) => {
  try {
    dirtyKeys.add(key);
    scheduleBroadcast();
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[FilterStore] markDirtyAndBroadcast skipped - BroadcastChannel is closed`);
    } else {
      warn(`[FilterStore] Error in markDirtyAndBroadcast:`, error);
    }
  }
};

// Unified CustomEvent listener for cross-window updates (consistent with selectionStore)
let handleCrossWindowUpdate: ((event: CustomEvent) => void) | null = null;

if (typeof window !== 'undefined') {
  handleCrossWindowUpdate = (event: CustomEvent) => {
    const payload = event.detail;
    if (!payload) return;
    
    isUpdatingFromCrossWindow = true;
    batch(() => {
      if (payload.selectedStates !== undefined) setSelectedStatesTimeseriesState(payload.selectedStates);
      if (payload.selectedRaces !== undefined) setSelectedRacesTimeseriesState(payload.selectedRaces);
      if (payload.selectedLegs !== undefined) setSelectedLegsTimeseriesState(payload.selectedLegs);
      if (payload.selectedGrades !== undefined) setSelectedGradesTimeseriesState(payload.selectedGrades);
      if (payload.raceOptions !== undefined) setRaceOptionsState(payload.raceOptions);
      if (payload.legOptions !== undefined) setLegOptionsState(payload.legOptions);
      if (payload.gradeOptions !== undefined) setGradeOptionsState(payload.gradeOptions);
      if (payload.selectedHeadsailCodes !== undefined) setSelectedHeadsailCodesState(payload.selectedHeadsailCodes);
      if (payload.selectedMainsailCodes !== undefined) setSelectedMainsailCodesState(payload.selectedMainsailCodes);
      if (payload.selectedSources !== undefined) setSelectedSourcesState(payload.selectedSources);
      if (payload.headsailCodeOptions !== undefined) setHeadsailCodeOptionsState(payload.headsailCodeOptions);
      if (payload.mainsailCodeOptions !== undefined) setMainsailCodeOptionsState(payload.mainsailCodeOptions);
      // Namespaced filter keys
      if (payload.selectedStatesManeuvers !== undefined) setSelectedStatesManeuversState(payload.selectedStatesManeuvers);
      if (payload.selectedRacesManeuvers !== undefined) setSelectedRacesManeuversState(payload.selectedRacesManeuvers);
      if (payload.selectedLegsManeuvers !== undefined) setSelectedLegsManeuversState(payload.selectedLegsManeuvers);
      if (payload.selectedGradesManeuvers !== undefined) setSelectedGradesManeuversState(payload.selectedGradesManeuvers);
      if (payload.maneuverTrainingRacing !== undefined) setManeuverTrainingRacingState(payload.maneuverTrainingRacing as 'TRAINING' | 'RACING' | null);
      if (payload.maneuverTimeseriesDescription !== undefined) {
        setManeuverTimeseriesDescriptionState(String(payload.maneuverTimeseriesDescription));
      }
      if (payload.selectedStatesAggregates !== undefined) setSelectedStatesAggregatesState(payload.selectedStatesAggregates);
      if (payload.selectedRacesAggregates !== undefined) setSelectedRacesAggregatesState(payload.selectedRacesAggregates);
      if (payload.selectedLegsAggregates !== undefined) setSelectedLegsAggregatesState(payload.selectedLegsAggregates);
      if (payload.selectedGradesAggregates !== undefined) setSelectedGradesAggregatesState(payload.selectedGradesAggregates);
      if (payload.selectedStatesTimeseries !== undefined) setSelectedStatesTimeseriesState(payload.selectedStatesTimeseries);
      if (payload.selectedRacesTimeseries !== undefined) setSelectedRacesTimeseriesState(payload.selectedRacesTimeseries);
      if (payload.selectedLegsTimeseries !== undefined) setSelectedLegsTimeseriesState(payload.selectedLegsTimeseries);
      if (payload.selectedGradesTimeseries !== undefined) setSelectedGradesTimeseriesState(payload.selectedGradesTimeseries);
    });
    isUpdatingFromCrossWindow = false;
  };
  
  window.addEventListener('filterStoreUpdate', handleCrossWindowUpdate as EventListener);
}

// Unified filter store: holds filter-related settings only

// ============================================================================
// Filter Signals: TWA States
// ============================================================================

// Declare all signal variables first (legacy selectedStates/selectedRaces/selectedLegs/selectedGrades now delegate to timeseries)
let raceOptionsState: any;
let setRaceOptionsState: any;
let legOptionsState: any;
let setLegOptionsState: any;
let gradeOptionsState: any;
let setGradeOptionsState: any;
let selectedHeadsailCodesState: any;
let setSelectedHeadsailCodesState: any;
let selectedMainsailCodesState: any;
let setSelectedMainsailCodesState: any;
let headsailCodeOptionsState: any;
let setHeadsailCodeOptionsState: any;
let _syncHeadsailCodeOptions: any;
let mainsailCodeOptionsState: any;
let setMainsailCodeOptionsState: any;
let _syncMainsailCodeOptions: any;
let selectedSourcesState: any;
let setSelectedSourcesState: any;
let hasChartsWithOwnFiltersState: any;
let setHasChartsWithOwnFiltersState: any;

// Namespaced filter signals (maneuvers / aggregates / timeseries)
let selectedStatesManeuversState: any;
let setSelectedStatesManeuversState: any;
let selectedRacesManeuversState: any;
let setSelectedRacesManeuversState: any;
let selectedLegsManeuversState: any;
let setSelectedLegsManeuversState: any;
let selectedGradesManeuversState: any;
let setSelectedGradesManeuversState: any;
let maneuverTrainingRacingState: any;
let setManeuverTrainingRacingState: any;
let maneuverTimeseriesDescriptionState: any;
let setManeuverTimeseriesDescriptionState: any;
let selectedStatesAggregatesState: any;
let setSelectedStatesAggregatesState: any;
let selectedRacesAggregatesState: any;
let setSelectedRacesAggregatesState: any;
let selectedLegsAggregatesState: any;
let setSelectedLegsAggregatesState: any;
let selectedGradesAggregatesState: any;
let setSelectedGradesAggregatesState: any;
let selectedStatesTimeseriesState: any;
let setSelectedStatesTimeseriesState: any;
let selectedRacesTimeseriesState: any;
let setSelectedRacesTimeseriesState: any;
let selectedLegsTimeseriesState: any;
let setSelectedLegsTimeseriesState: any;
let selectedGradesTimeseriesState: any;
let setSelectedGradesTimeseriesState: any;
let isTrainingHourModeState: any;
let setIsTrainingHourModeState: any;

// Initialize all signals within a createRoot to avoid cleanup warnings
createRoot(() => {
  [raceOptionsState, setRaceOptionsState] = createSyncSignal<string[]>([], { key: 'raceOptions', autoSync: true });
  [legOptionsState, setLegOptionsState] = createSyncSignal<string[]>([], { key: 'legOptions', autoSync: true });
  [gradeOptionsState, setGradeOptionsState] = createSyncSignal<string[]>([], { key: 'gradeOptions', autoSync: true });
  [selectedHeadsailCodesState, setSelectedHeadsailCodesState] = createSyncSignal<string[]>([], { key: 'selectedHeadsailCodes', autoSync: true });
  [selectedMainsailCodesState, setSelectedMainsailCodesState] = createSyncSignal<string[]>([], { key: 'selectedMainsailCodes', autoSync: true });
  [headsailCodeOptionsState, setHeadsailCodeOptionsState, _syncHeadsailCodeOptions] = createSyncSignal<string[]>([], { 
    key: 'headsailCodeOptions', 
    autoSync: true 
  });
  [mainsailCodeOptionsState, setMainsailCodeOptionsState, _syncMainsailCodeOptions] = createSyncSignal<string[]>([], { 
    key: 'mainsailCodeOptions', 
    autoSync: true 
  });
  [selectedSourcesState, setSelectedSourcesState] = createSyncSignal<string[]>([], { key: 'selectedSources', autoSync: true });
  [hasChartsWithOwnFiltersState, setHasChartsWithOwnFiltersState] = createSyncSignal(false, {
    key: "hasChartsWithOwnFilters", 
    autoSync: true
  });
  // Maneuver filter selections: autoSync false — sync to other tabs/popups via main window postMessage (Sidebar), not IndexedDB.
  [selectedStatesManeuversState, setSelectedStatesManeuversState] = createSyncSignal<string[]>([], { key: 'selectedStatesManeuvers', autoSync: false });
  [selectedRacesManeuversState, setSelectedRacesManeuversState] = createSyncSignal<string[]>([], { key: 'selectedRacesManeuvers', autoSync: false });
  [selectedLegsManeuversState, setSelectedLegsManeuversState] = createSyncSignal<string[]>([], { key: 'selectedLegsManeuvers', autoSync: false });
  [selectedGradesManeuversState, setSelectedGradesManeuversState] = createSyncSignal<string[]>([], { key: 'selectedGradesManeuvers', autoSync: false });
  [maneuverTrainingRacingState, setManeuverTrainingRacingState] = createSyncSignal<'TRAINING' | 'RACING' | null>(null, {
    key: 'maneuverTrainingRacing',
    autoSync: false,
  });
  [maneuverTimeseriesDescriptionState, setManeuverTimeseriesDescriptionState] = createSyncSignal<string>('BASICS', {
    key: 'maneuverTimeseriesDescription',
    autoSync: false,
  });
  [selectedStatesAggregatesState, setSelectedStatesAggregatesState] = createSyncSignal<string[]>([], { key: 'selectedStatesAggregates', autoSync: true });
  [selectedRacesAggregatesState, setSelectedRacesAggregatesState] = createSyncSignal<string[]>([], { key: 'selectedRacesAggregates', autoSync: true });
  [selectedLegsAggregatesState, setSelectedLegsAggregatesState] = createSyncSignal<string[]>([], { key: 'selectedLegsAggregates', autoSync: true });
  [selectedGradesAggregatesState, setSelectedGradesAggregatesState] = createSyncSignal<string[]>([], { key: 'selectedGradesAggregates', autoSync: true });
  [selectedStatesTimeseriesState, setSelectedStatesTimeseriesState] = createSyncSignal<string[]>([], { key: 'selectedStatesTimeseries', autoSync: true });
  [selectedRacesTimeseriesState, setSelectedRacesTimeseriesState] = createSyncSignal<string[]>([], { key: 'selectedRacesTimeseries', autoSync: true });
  [selectedLegsTimeseriesState, setSelectedLegsTimeseriesState] = createSyncSignal<string[]>([], { key: 'selectedLegsTimeseries', autoSync: true });
  [selectedGradesTimeseriesState, setSelectedGradesTimeseriesState] = createSyncSignal<string[]>([], { key: 'selectedGradesTimeseries', autoSync: true });
  [isTrainingHourModeState, setIsTrainingHourModeState] = createSignal(false);

  // Save selectedSources to persistent settings API when changed
  // This effect must be inside createRoot to be properly disposed
  createEffect(() => {
    if (!selectedSourcesState) return;
    const sources = Array.isArray(selectedSourcesState()) ? selectedSourcesState() : [];
    if (sources.length === 0) return; // Don't save empty selections
    
    untrack(async () => {
      const currentUser = user();
      if (currentUser?.user_id) {
        const { selectedClassName, selectedProjectId } = persistantStore;
        const className = selectedClassName();
        const projectId = selectedProjectId();
        
        if (className && projectId) {
          try {
            await persistentSettingsService.saveSettings(
              currentUser.user_id,
              className,
              projectId,
              { fleetPerformanceSources: sources }
            );
            debug('filterStore: Saved selectedSources to API', sources);
          } catch (error) {
            debug('filterStore: Error saving selectedSources to API', error);
          }
        }
      }
    });
  });
});

// ============================================================================
// Legacy filter API (delegates to timeseries context for backward compatibility)
// Prefer selectedStatesTimeseries / setSelectedStatesTimeseries etc. by context.
// ============================================================================

export const selectedStates = (): string[] => selectedStatesTimeseries();
export const setSelectedStates = (value: string[]) => setSelectedStatesTimeseries(value);

export const selectedRaces = (): string[] => selectedRacesTimeseries();
export const setSelectedRaces = (value: string[]) => setSelectedRacesTimeseries(value);

export const selectedLegs = (): string[] => selectedLegsTimeseries();
export const setSelectedLegs = (value: string[]) => setSelectedLegsTimeseries(value);

export const selectedGrades = (): string[] => selectedGradesTimeseries();
export const setSelectedGrades = (value: string[]) => setSelectedGradesTimeseries(value);

export const raceOptions = (): string[] => {
  try {
    const value = raceOptionsState();
    return Array.isArray(value) ? value : [];
  } catch (error) {
    logError('Error accessing raceOptions:', error);
    return [];
  }
};
export const setRaceOptions = (value: (string | number)[]) => {
  try {
    const normalized = Array.isArray(value) ? value.map((v) => String(v)) : [];
    const current = raceOptionsState();
    const curArr = Array.isArray(current) ? current : [];
    const same = curArr.length === normalized.length && curArr.every((c, i) => String(c) === normalized[i]);
    if (same) return;
    setRaceOptionsState(normalized);
    markDirtyAndBroadcast('raceOptions');
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[FilterStore] setRaceOptions skipped - BroadcastChannel is closed`);
    } else {
      warn(`[FilterStore] Error in setRaceOptions:`, error);
    }
  }
};

/** True when date/races returned training hours (HOUR 0,1,2...) instead of races; used for fleet map and map settings. */
export const isTrainingHourMode = (): boolean => {
  try {
    return Boolean(isTrainingHourModeState?.());
  } catch {
    return false;
  }
};
export const setIsTrainingHourMode = (value: boolean) => {
  try {
    setIsTrainingHourModeState?.(value);
  } catch (e: any) {
    warn('[FilterStore] setIsTrainingHourMode:', e);
  }
};

export const legOptions = (): string[] => {
  try {
    const value = legOptionsState();
    return Array.isArray(value) ? value : [];
  } catch (error) {
    logError('Error accessing legOptions:', error);
    return [];
  }
};
export const setLegOptions = (value: string[]) => {
  try {
    setLegOptionsState(value);
    markDirtyAndBroadcast('legOptions');
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[FilterStore] setLegOptions skipped - BroadcastChannel is closed`);
    } else {
      warn(`[FilterStore] Error in setLegOptions:`, error);
    }
  }
};

export const gradeOptions = (): string[] => {
  try {
    const value = gradeOptionsState();
    return Array.isArray(value) ? value : [];
  } catch (error) {
    logError('Error accessing gradeOptions:', error);
    return [];
  }
};
export const setGradeOptions = (value: string[]) => {
  try {
    setGradeOptionsState(value);
    markDirtyAndBroadcast('gradeOptions');
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[FilterStore] setGradeOptions skipped - BroadcastChannel is closed`);
    } else {
      warn(`[FilterStore] Error in setGradeOptions:`, error);
    }
  }
};

// ============================================================================
// Namespaced filter signals (maneuvers / aggregates / timeseries)
// ============================================================================

const safeArray = (v: unknown): string[] => (Array.isArray(v) ? v : []);

export const selectedStatesManeuvers = (): string[] => {
  try { return safeArray(selectedStatesManeuversState?.()); } catch { return []; }
};
export const setSelectedStatesManeuvers = (value: string[]) => {
  try { setSelectedStatesManeuversState(value); markDirtyAndBroadcast('selectedStatesManeuvers'); } catch (e: any) { warn('[FilterStore] setSelectedStatesManeuvers:', e); }
};
export const selectedRacesManeuvers = (): string[] => {
  try { return safeArray(selectedRacesManeuversState?.()); } catch { return []; }
};
export const setSelectedRacesManeuvers = (value: string[]) => {
  try { setSelectedRacesManeuversState(value); markDirtyAndBroadcast('selectedRacesManeuvers'); } catch (e: any) { warn('[FilterStore] setSelectedRacesManeuvers:', e); }
};
export const selectedLegsManeuvers = (): string[] => {
  try { return safeArray(selectedLegsManeuversState?.()); } catch { return []; }
};
export const setSelectedLegsManeuvers = (value: string[]) => {
  try { setSelectedLegsManeuversState(value); markDirtyAndBroadcast('selectedLegsManeuvers'); } catch (e: any) { warn('[FilterStore] setSelectedLegsManeuvers:', e); }
};
export const selectedGradesManeuvers = (): string[] => {
  try { return safeArray(selectedGradesManeuversState?.()); } catch { return []; }
};
export const setSelectedGradesManeuvers = (value: string[]) => {
  try { setSelectedGradesManeuversState(value); markDirtyAndBroadcast('selectedGradesManeuvers'); } catch (e: any) { warn('[FilterStore] setSelectedGradesManeuvers:', e); }
};

export type ManeuverTrainingRacing = 'TRAINING' | 'RACING' | null;

export const maneuverTrainingRacing = (): ManeuverTrainingRacing => {
  try {
    const v = maneuverTrainingRacingState?.();
    return v === 'TRAINING' || v === 'RACING' ? v : null;
  } catch {
    return null;
  }
};
export const setManeuverTrainingRacing = (value: ManeuverTrainingRacing) => {
  try {
    setManeuverTrainingRacingState(value);
    markDirtyAndBroadcast('maneuverTrainingRacing');
  } catch (e: any) {
    warn('[FilterStore] setManeuverTrainingRacing:', e);
  }
};

export const maneuverTimeseriesDescription = (): string => {
  try {
    const v = maneuverTimeseriesDescriptionState?.();
    return typeof v === 'string' && v.trim() !== '' ? v : 'BASICS';
  } catch {
    return 'BASICS';
  }
};
export const setManeuverTimeseriesDescription = (value: string) => {
  try {
    setManeuverTimeseriesDescriptionState(value && String(value).trim() !== '' ? String(value) : 'BASICS');
    markDirtyAndBroadcast('maneuverTimeseriesDescription');
  } catch (e: any) {
    warn('[FilterStore] setManeuverTimeseriesDescription:', e);
  }
};

export const selectedStatesAggregates = (): string[] => {
  try { return safeArray(selectedStatesAggregatesState?.()); } catch { return []; }
};
export const setSelectedStatesAggregates = (value: string[]) => {
  try { setSelectedStatesAggregatesState(value); markDirtyAndBroadcast('selectedStatesAggregates'); } catch (e: any) { warn('[FilterStore] setSelectedStatesAggregates:', e); }
};
export const selectedRacesAggregates = (): string[] => {
  try { return safeArray(selectedRacesAggregatesState?.()); } catch { return []; }
};
export const setSelectedRacesAggregates = (value: string[]) => {
  try { setSelectedRacesAggregatesState(value); markDirtyAndBroadcast('selectedRacesAggregates'); } catch (e: any) { warn('[FilterStore] setSelectedRacesAggregates:', e); }
};
export const selectedLegsAggregates = (): string[] => {
  try { return safeArray(selectedLegsAggregatesState?.()); } catch { return []; }
};
export const setSelectedLegsAggregates = (value: string[]) => {
  try { setSelectedLegsAggregatesState(value); markDirtyAndBroadcast('selectedLegsAggregates'); } catch (e: any) { warn('[FilterStore] setSelectedLegsAggregates:', e); }
};
export const selectedGradesAggregates = (): string[] => {
  try { return safeArray(selectedGradesAggregatesState?.()); } catch { return []; }
};
export const setSelectedGradesAggregates = (value: string[]) => {
  try { setSelectedGradesAggregatesState(value); markDirtyAndBroadcast('selectedGradesAggregates'); } catch (e: any) { warn('[FilterStore] setSelectedGradesAggregates:', e); }
};

export const selectedStatesTimeseries = (): string[] => {
  try { return safeArray(selectedStatesTimeseriesState?.()); } catch { return []; }
};
export const setSelectedStatesTimeseries = (value: string[]) => {
  try { setSelectedStatesTimeseriesState(value); markDirtyAndBroadcast('selectedStatesTimeseries'); } catch (e: any) { warn('[FilterStore] setSelectedStatesTimeseries:', e); }
};
export const selectedRacesTimeseries = (): string[] => {
  try { return safeArray(selectedRacesTimeseriesState?.()); } catch { return []; }
};
export const setSelectedRacesTimeseries = (value: string[]) => {
  try { setSelectedRacesTimeseriesState(value); markDirtyAndBroadcast('selectedRacesTimeseries'); } catch (e: any) { warn('[FilterStore] setSelectedRacesTimeseries:', e); }
};
export const selectedLegsTimeseries = (): string[] => {
  try { return safeArray(selectedLegsTimeseriesState?.()); } catch { return []; }
};
export const setSelectedLegsTimeseries = (value: string[]) => {
  try { setSelectedLegsTimeseriesState(value); markDirtyAndBroadcast('selectedLegsTimeseries'); } catch (e: any) { warn('[FilterStore] setSelectedLegsTimeseries:', e); }
};
export const selectedGradesTimeseries = (): string[] => {
  try { return safeArray(selectedGradesTimeseriesState?.()); } catch { return []; }
};
export const setSelectedGradesTimeseries = (value: string[]) => {
  try { setSelectedGradesTimeseriesState(value); markDirtyAndBroadcast('selectedGradesTimeseries'); } catch (e: any) { warn('[FilterStore] setSelectedGradesTimeseries:', e); }
};

export interface FilterStateForContext {
  selectedStates: string[];
  selectedRaces: string[];
  selectedLegs: string[];
  selectedGrades: string[];
}

export const getCurrentFilterStateForContext = (context: FilterContext): FilterStateForContext => {
  switch (context) {
    case 'maneuvers':
      return { selectedStates: selectedStatesManeuvers(), selectedRaces: selectedRacesManeuvers(), selectedLegs: selectedLegsManeuvers(), selectedGrades: selectedGradesManeuvers() };
    case 'aggregates':
      return { selectedStates: selectedStatesAggregates(), selectedRaces: selectedRacesAggregates(), selectedLegs: selectedLegsAggregates(), selectedGrades: selectedGradesAggregates() };
    case 'timeseries':
      return { selectedStates: selectedStatesTimeseries(), selectedRaces: selectedRacesTimeseries(), selectedLegs: selectedLegsTimeseries(), selectedGrades: selectedGradesTimeseries() };
  }
};

export const setSelectedStatesForContext = (context: FilterContext, value: string[]) => {
  switch (context) { case 'maneuvers': setSelectedStatesManeuvers(value); break; case 'aggregates': setSelectedStatesAggregates(value); break; case 'timeseries': setSelectedStatesTimeseries(value); break; }
};
export const setSelectedRacesForContext = (context: FilterContext, value: string[]) => {
  switch (context) { case 'maneuvers': setSelectedRacesManeuvers(value); break; case 'aggregates': setSelectedRacesAggregates(value); break; case 'timeseries': setSelectedRacesTimeseries(value); break; }
};
export const setSelectedLegsForContext = (context: FilterContext, value: string[]) => {
  switch (context) { case 'maneuvers': setSelectedLegsManeuvers(value); break; case 'aggregates': setSelectedLegsAggregates(value); break; case 'timeseries': setSelectedLegsTimeseries(value); break; }
};
export const setSelectedGradesForContext = (context: FilterContext, value: string[]) => {
  switch (context) { case 'maneuvers': setSelectedGradesManeuvers(value); break; case 'aggregates': setSelectedGradesAggregates(value); break; case 'timeseries': setSelectedGradesTimeseries(value); break; }
};

export const hasActiveManeuverFilters = (): boolean =>
  selectedStatesManeuvers().length > 0 ||
  selectedRacesManeuvers().length > 0 ||
  selectedLegsManeuvers().length > 0 ||
  selectedGradesManeuvers().length > 0 ||
  maneuverTrainingRacing() != null;
export const hasActiveAggregateFilters = (): boolean =>
  selectedStatesAggregates().length > 0 || selectedRacesAggregates().length > 0 || selectedLegsAggregates().length > 0 || selectedGradesAggregates().length > 0;
export const hasActiveTimeseriesFilters = (): boolean =>
  selectedStatesTimeseries().length > 0 || selectedRacesTimeseries().length > 0 || selectedLegsTimeseries().length > 0 || selectedGradesTimeseries().length > 0;

export const clearManeuverFilters = () => {
  try {
    clearSyncData('selectedStatesManeuvers'); clearSyncData('selectedRacesManeuvers'); clearSyncData('selectedLegsManeuvers'); clearSyncData('selectedGradesManeuvers');
    clearSyncData('maneuverTrainingRacing');
    clearSyncData('maneuverTimeseriesDescription');
    setSelectedStatesManeuvers([]); setSelectedRacesManeuvers([]); setSelectedLegsManeuvers([]); setSelectedGradesManeuvers([]);
    setManeuverTrainingRacing(null);
    setManeuverTimeseriesDescription('BASICS');
  } catch (e) { warn('[FilterStore] clearManeuverFilters:', e); }
};
export const clearAggregateFilters = () => {
  try {
    clearSyncData('selectedStatesAggregates'); clearSyncData('selectedRacesAggregates'); clearSyncData('selectedLegsAggregates'); clearSyncData('selectedGradesAggregates');
    setSelectedStatesAggregates([]); setSelectedRacesAggregates([]); setSelectedLegsAggregates([]); setSelectedGradesAggregates([]);
  } catch (e) { warn('[FilterStore] clearAggregateFilters:', e); }
};
export const clearTimeseriesFilters = () => {
  try {
    clearSyncData('selectedStatesTimeseries'); clearSyncData('selectedRacesTimeseries'); clearSyncData('selectedLegsTimeseries'); clearSyncData('selectedGradesTimeseries');
    setSelectedStatesTimeseries([]); setSelectedRacesTimeseries([]); setSelectedLegsTimeseries([]); setSelectedGradesTimeseries([]);
  } catch (e) { warn('[FilterStore] clearTimeseriesFilters:', e); }
};

export const selectedHeadsailCodes = (): string[] => {
  try {
    const value = selectedHeadsailCodesState();
    return Array.isArray(value) ? value : [];
  } catch (error) {
    logError('Error accessing selectedHeadsailCodes:', error);
    return [];
  }
};
export const setSelectedHeadsailCodes = (value: string[]) => {
  try {
    setSelectedHeadsailCodesState(value);
    markDirtyAndBroadcast('selectedHeadsailCodes');
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[FilterStore] setSelectedHeadsailCodes skipped - BroadcastChannel is closed`);
    } else {
      warn(`[FilterStore] Error in setSelectedHeadsailCodes:`, error);
    }
  }
};

export const selectedMainsailCodes = (): string[] => {
  try {
    const value = selectedMainsailCodesState();
    return Array.isArray(value) ? value : [];
  } catch (error) {
    logError('Error accessing selectedMainsailCodes:', error);
    return [];
  }
};
export const setSelectedMainsailCodes = (value: string[]) => {
  try {
    setSelectedMainsailCodesState(value);
    markDirtyAndBroadcast('selectedMainsailCodes');
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[FilterStore] setSelectedMainsailCodes skipped - BroadcastChannel is closed`);
    } else {
      warn(`[FilterStore] Error in setSelectedMainsailCodes:`, error);
    }
  }
};

// ============================================================================
// Filter Signals: Source Filters (for Fleet Performance)
// ============================================================================

export const selectedSources = (): string[] => {
  try {
    const value = selectedSourcesState();
    return Array.isArray(value) ? value : [];
  } catch (error) {
    logError('Error accessing selectedSources:', error);
    return [];
  }
};

export const setSelectedSources = (value: string[]) => {
  try {
    setSelectedSourcesState(value);
    markDirtyAndBroadcast('selectedSources');
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[FilterStore] setSelectedSources skipped - BroadcastChannel is closed`);
    } else {
      warn(`[FilterStore] Error in setSelectedSources:`, error);
    }
  }
};

// ============================================================================
// Filter Signals: Sail Code Options
// ============================================================================

export const headsailCodeOptions = (): string[] => {
  try {
    const value = headsailCodeOptionsState();
    return Array.isArray(value) ? value : [];
  } catch (error) {
    logError('Error accessing headsailCodeOptions:', error);
    return [];
  }
};
export const setHeadsailCodeOptions = (value: string[]) => {
  try {
    setHeadsailCodeOptionsState(value);
    markDirtyAndBroadcast('headsailCodeOptions');
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[FilterStore] setHeadsailCodeOptions skipped - BroadcastChannel is closed`);
    } else {
      warn(`[FilterStore] Error in setHeadsailCodeOptions:`, error);
    }
  }
};

export const mainsailCodeOptions = (): string[] => {
  try {
    const value = mainsailCodeOptionsState();
    return Array.isArray(value) ? value : [];
  } catch (error) {
    logError('Error accessing mainsailCodeOptions:', error);
    return [];
  }
};
export const setMainsailCodeOptions = (value: string[]) => {
  try {
    setMainsailCodeOptionsState(value);
    markDirtyAndBroadcast('mainsailCodeOptions');
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[FilterStore] setMainsailCodeOptions skipped - BroadcastChannel is closed`);
    } else {
      warn(`[FilterStore] Error in setMainsailCodeOptions:`, error);
    }
  }
};

/**
 * Clear all filter data from persistent storage
 * This removes all filter-related sync data but does not reset signal values
 * Note: clearSyncData now automatically triggers cleanup for registered signals
 */
export const clearFilterData = () => {
  clearSyncData('raceOptions');
  clearSyncData('legOptions');
  clearSyncData('gradeOptions');
  clearSyncData('selectedHeadsailCodes');
  clearSyncData('selectedMainsailCodes');
  clearSyncData('selectedSources');
  clearSyncData('headsailCodeOptions');
  clearSyncData('mainsailCodeOptions');
  clearSyncData('hasChartsWithOwnFilters');
  clearSyncData('selectedStatesManeuvers');
  clearSyncData('selectedRacesManeuvers');
  clearSyncData('selectedLegsManeuvers');
  clearSyncData('selectedGradesManeuvers');
  clearSyncData('maneuverTrainingRacing');
  clearSyncData('maneuverTimeseriesDescription');
  clearSyncData('selectedStatesAggregates');
  clearSyncData('selectedRacesAggregates');
  clearSyncData('selectedLegsAggregates');
  clearSyncData('selectedGradesAggregates');
  clearSyncData('selectedStatesTimeseries');
  clearSyncData('selectedRacesTimeseries');
  clearSyncData('selectedLegsTimeseries');
  clearSyncData('selectedGradesTimeseries');
};

/**
 * Dispose function to clean up all filter store sync signals
 * This should be called during component cleanup
 */
export function disposeFilterStore(): void {
  // Clean up cross-window event listener
  if (typeof window !== 'undefined' && handleCrossWindowUpdate) {
    window.removeEventListener('filterStoreUpdate', handleCrossWindowUpdate as EventListener);
    handleCrossWindowUpdate = null;
  }
  
  // Clean up all sync signals
  clearSyncData('raceOptions');
  clearSyncData('legOptions');
  clearSyncData('gradeOptions');
  clearSyncData('selectedHeadsailCodes');
  clearSyncData('selectedMainsailCodes');
  clearSyncData('selectedSources');
  clearSyncData('headsailCodeOptions');
  clearSyncData('mainsailCodeOptions');
  clearSyncData('hasChartsWithOwnFilters');
  clearSyncData('selectedStatesManeuvers');
  clearSyncData('selectedRacesManeuvers');
  clearSyncData('selectedLegsManeuvers');
  clearSyncData('selectedGradesManeuvers');
  clearSyncData('maneuverTrainingRacing');
  clearSyncData('maneuverTimeseriesDescription');
  clearSyncData('selectedStatesAggregates');
  clearSyncData('selectedRacesAggregates');
  clearSyncData('selectedLegsAggregates');
  clearSyncData('selectedGradesAggregates');
  clearSyncData('selectedStatesTimeseries');
  clearSyncData('selectedRacesTimeseries');
  clearSyncData('selectedLegsTimeseries');
  clearSyncData('selectedGradesTimeseries');
}

/**
 * This function should be called within a component to properly register cleanup
 */
let appCleanupDispose: (() => void) | null = null;
export function registerFilterStoreCleanup(): void {
  if (appCleanupDispose) {
    appCleanupDispose();
  }
  appCleanupDispose = createRoot((dispose) => {
    // Wrap onCleanup in createEffect to ensure it's called within a reactive context
    // Use untrack to prevent the effect from tracking any reactive dependencies
    createEffect(() => {
      untrack(() => {
        onCleanup(() => {
          disposeFilterStore();
        });
      });
    });
    return dispose;
  });
}

// ============================================================================
// Date Range Signals (Non-persistent - reset on page load)
// ============================================================================

let startDateStateAccessor: () => string;
let setStartDateStateSetter: (value: string) => void;
let endDateStateAccessor: () => string;
let setEndDateStateSetter: (value: string) => void;

createRoot(() => {
  const [startDateSig, setStartDateSig] = createSignal<string>('');
  const [endDateSig, setEndDateSig] = createSignal<string>('');
  startDateStateAccessor = startDateSig;
  setStartDateStateSetter = setStartDateSig;
  endDateStateAccessor = endDateSig;
  setEndDateStateSetter = setEndDateSig;
});

/**
 * Start date for filtering performance data (YYYY-MM-DD format)
 * Non-persistent - resets to 30 days before last_date when page loads
 */
export const startDate = (): string => startDateStateAccessor!();
export const setStartDate = (value: string) => {
  setStartDateStateSetter!(value);
};

/**
 * End date for filtering performance data (YYYY-MM-DD format)
 * Non-persistent - resets to last_date when page loads
 */
export const endDate = (): string => endDateStateAccessor!();
export const setEndDate = (value: string) => {
  setEndDateStateSetter!(value);
};

/**
 * Initialize date range from dataset last_date API
 * Sets endDate to last_date and startDate to 1 year (365 days) before
 * For history plots: startDate is persistent (only set if not already set), endDate always updates
 * Should be called when page loads or when dataset/project changes
 */
export const initializeDateRange = async (): Promise<void> => {
  try {
    const { selectedClassName, selectedProjectId, selectedSourceId } = persistantStore;
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const sourceId = selectedSourceId();

    if (!className || !projectId || sourceId === undefined) {
      log('FilterStore: Cannot initialize date range - missing required values');
      // Only clear if both are empty
      if (!startDate() && !endDate()) {
        setStartDate('');
        setEndDate('');
      }
      return;
    }

    const controller = new AbortController();
    const result = await getData(
      `${apiEndpoints.app.datasets}/last_date?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&source_id=${encodeURIComponent(sourceId)}`,
      controller.signal
    );

    if (result.success && result.data) {
      const dateStr = String(result.data).trim();
      const endDateValue = new Date(dateStr);
      if (isNaN(endDateValue.getTime())) {
        log('FilterStore: last_date invalid, skipping');
        return;
      }
      const startDateValue = new Date(endDateValue.getTime());
      startDateValue.setDate(startDateValue.getDate() - 365);

      // Format as YYYY-MM-DD
      const formatDate = (date: Date): string => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      };

      const formattedEndDate = formatDate(endDateValue);
      const formattedStartDate = formatDate(startDateValue);
      const validFormat = /^\d{4}-\d{2}-\d{2}$/;
      if (!validFormat.test(formattedEndDate) || !validFormat.test(formattedStartDate)) {
        log('FilterStore: Formatted dates invalid, skipping');
        return;
      }

      // Set end date first so it is never left empty
      setEndDate(formattedEndDate);
      // Only set startDate if it's not already set (persistent for history plots)
      if (!startDate()) {
        setStartDate(formattedStartDate);
        log('FilterStore: Date range initialized', { startDate: formattedStartDate, endDate: formattedEndDate });
      } else {
        log('FilterStore: End date updated, start date preserved', { startDate: startDate(), endDate: formattedEndDate });
      }
    } else {
      log('FilterStore: Failed to fetch last_date');
      // Only clear endDate if fetch failed, preserve startDate
      if (!endDate()) {
        setEndDate('');
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return;
    }
    logError('FilterStore: Error initializing date range:', err);
    // Don't clear dates on error, preserve what we have
  }
};

/**
 * Get formatted filter labels for UI display (e.g., "Race 1", "Leg 2", "Upwind")
 * This replaces the selectedFilters computed from selectionStore
 */
export const getFormattedFilters = (): string[] => {
  try {
    // State, grade, race, and leg filters are used for filtering but don't show in selection banner
    // Only return empty array so they don't appear in the banner
    // These filters are still active and applied to data, just not displayed in the banner
    return [];
  } catch (error) {
    logError("Error getting formatted filters:", error);
    return [];
  }
};

/**
 * Alias for getFormattedFilters for backward compatibility
 * Export as selectedFilters since this is the legacy name
 */
export const selectedFilters = getFormattedFilters;

/**
 * Alias for clearAllFilters for backward compatibility
 * This function clears all filter selections
 */
export const setSelectedFilters = (value: string[]) => {
  // If value is empty array, clear all filters
  if (value.length === 0) {
    clearAllFilters();
  } else {
    // If there's a value, it's not a valid operation anymore
    // This is kept for backward compatibility only
    warn("setSelectedFilters with values is deprecated. Use individual filter setters instead.");
  }
};

/**
 * Check if any filters are currently active (any context)
 */
export const hasActiveFilters = (): boolean => {
  return hasActiveManeuverFilters() || hasActiveAggregateFilters() || hasActiveTimeseriesFilters() || selectedSources().length > 0;
};

/**
 * Clear all active filters in all contexts (not options, just selections)
 */
export const clearAllFilters = () => {
  log('FilterStore: clearAllFilters called');
  try {
    clearManeuverFilters();
    clearAggregateFilters();
    clearTimeseriesFilters();
    setSelectedSources([]);
    setSelectedHeadsailCodes([]);
    setSelectedMainsailCodes([]);
  } catch (error: any) {
    if (!error?.message?.includes('BroadcastChannel') && !error?.message?.includes('Channel is closed')) {
      warn('FilterStore: Unexpected error in clearAllFilters:', error);
    }
  }
};

/**
 * Get debug information about current filter state and synchronization status
 * Useful for debugging cross-window sync issues
 */
export const getFilterDebugInfo = () => ({
  selectedStates: selectedStates(),
  selectedRaces: selectedRaces(),
  selectedLegs: selectedLegs(),
  selectedGrades: selectedGrades(),
  maneuvers: { states: selectedStatesManeuvers(), races: selectedRacesManeuvers(), legs: selectedLegsManeuvers(), grades: selectedGradesManeuvers() },
  aggregates: { states: selectedStatesAggregates(), races: selectedRacesAggregates(), legs: selectedLegsAggregates(), grades: selectedGradesAggregates() },
  timeseries: { states: selectedStatesTimeseries(), races: selectedRacesTimeseries(), legs: selectedLegsTimeseries(), grades: selectedGradesTimeseries() },
  selectedSources: selectedSources(),
  raceOptions: raceOptions(),
  legOptions: legOptions(),
  gradeOptions: gradeOptions(),
  selectedHeadsailCodes: selectedHeadsailCodes(),
  selectedMainsailCodes: selectedMainsailCodes(),
  hasActiveFilters: hasActiveFilters(),
  hasActiveManeuverFilters: hasActiveManeuverFilters(),
  hasActiveAggregateFilters: hasActiveAggregateFilters(),
  hasActiveTimeseriesFilters: hasActiveTimeseriesFilters(),
  formattedFilters: getFormattedFilters(),
  pendingBroadcast,
  dirtyKeys: Array.from(dirtyKeys),
  isUpdatingFromCrossWindow
});

// ============================================================================
// Chart filter tracking
// ============================================================================

/**
 * Tracks whether the current page has charts with their own filters
 * This affects whether global filters should be applied at the data layer
 */
export const hasChartsWithOwnFilters = () => Boolean(hasChartsWithOwnFiltersState());
export const setHasChartsWithOwnFilters = (value: boolean) => {
  try {
    setHasChartsWithOwnFiltersState(Boolean(value));
  } catch (error: any) {
    // BroadcastChannel might be closed (e.g., during page unload or tab close)
    if (error?.message?.includes('BroadcastChannel') || error?.message?.includes('Channel is closed')) {
      debug(`[FilterStore] setHasChartsWithOwnFilters skipped - BroadcastChannel is closed`);
    } else {
      warn(`[FilterStore] Error in setHasChartsWithOwnFilters:`, error);
    }
  }
};

// Export snapshot function for debugging
export { getFilterSnapshot };

// Make debug function globally accessible for console debugging
if (typeof window !== 'undefined') {
  (window as any).debugFilters = getFilterDebugInfo;
}


