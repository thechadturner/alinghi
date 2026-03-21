/**
 * Live Sources Store
 *
 * Stores the selected source IDs for live mode (map settings toggles).
 * Shared between LiveMap, MapContainer, and RealtimeDataTable so they all
 * show only the sources the user has toggled on in map settings.
 */

import { createRoot, createSignal, Accessor } from 'solid-js';
import { debug as logDebug } from '../utils/console';

interface LiveSourcesStore {
  /** Selected source IDs (from map settings toggles) */
  selectedSourceIds: Accessor<Set<number>>;
  /** Set selected source IDs */
  setSelectedSourceIds: (ids: Set<number>) => void;
  /** Clear selection (e.g. when leaving live mode) */
  clear: () => void;
}

export const liveSourcesStore = createRoot<LiveSourcesStore>(() => {
  const [selectedSourceIds, setSelectedSourceIds] = createSignal<Set<number>>(new Set());

  const setIds = (ids: Set<number>) => {
    setSelectedSourceIds(new Set(ids));
    logDebug('[LiveSourcesStore] Updated selected sources', {
      count: ids.size,
      ids: Array.from(ids)
    });
  };

  const clear = () => {
    setSelectedSourceIds(new Set());
    logDebug('[LiveSourcesStore] Cleared selected sources');
  };

  return {
    selectedSourceIds,
    setSelectedSourceIds: setIds,
    clear
  };
});
