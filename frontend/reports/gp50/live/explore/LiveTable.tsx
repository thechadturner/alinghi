import { createSignal, createMemo, createEffect, For, Show, onMount, onCleanup } from "solid-js";
import { FiSettings } from "solid-icons/fi";
import { sourcesStore } from "../../../../store/sourcesStore";
import { liveSourcesStore } from "../../../../store/liveSourcesStore";
import { debug, warn, error as logError } from "../../../../utils/console";
import { apiEndpoints } from "@config/env";
import { getData, postData } from "../../../../utils/global";
import LiveChannelPicker from "../../../../components/utilities/LiveChannelPicker";
import { LIVE_CHANNELS } from "../../../../constants/liveChannels";
import { persistantStore } from "../../../../store/persistantStore";
import { user } from "../../../../store/userStore";
import { streamingDataService } from "../../../../services/streamingDataService";

/** Same key as LiveMap: local storage and user object name for live source selection. */
const LIVE_SOURCES_KEY = 'live_sources';
const LIVE_SOURCES_PARENT = 'live';

/** Filter mode for "last 5 minutes": latest = all points; others = last 5 min where Twa_deg in band. */
export type LiveTableWindowMode = 'latest' | 'upwind' | 'reaching' | 'downwind';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** TWA bands: Upwind 25–75°, Reaching 75–125°, Downwind 125–160° (all use abs(Twa_deg)). */
function pointMatchesTwaMode(pt: Record<string, unknown>, mode: LiveTableWindowMode): boolean {
  const raw = pt['Twa_deg'] ?? pt['twa_deg'];
  if (raw === null || raw === undefined) return false;
  const twa = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(twa)) return false;
  const absTwa = Math.abs(twa);
  switch (mode) {
    case 'upwind': return absTwa > 25 && absTwa < 75;
    case 'reaching': return absTwa > 75 && absTwa < 125;
    case 'downwind': return absTwa > 125 && absTwa < 160;
    default: return true;
  }
}

function getStoredLiveSources(): Record<string, number[]> {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return {};
  try {
    let raw = localStorage.getItem(LIVE_SOURCES_KEY);
    if (!raw) {
      const legacy = localStorage.getItem('liveMapSelectedSourceIds');
      if (legacy) {
        const parsed = JSON.parse(legacy);
        const data = typeof parsed === 'object' && parsed !== null ? parsed : {};
        try {
          localStorage.setItem(LIVE_SOURCES_KEY, JSON.stringify(data));
        } catch {
          // ignore
        }
        return data;
      }
      return {};
    }
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

interface TableRow {
  rowType: 'source_name' | 'channel';
  label: string;
  [sourceName: string]: string | number | null | boolean | 'source_name' | 'channel';
}

interface CellValue {
  value: string | number | null;
  formatted: string;
  updateKey: number; // Increments on each update for smooth transitions
  isStale?: boolean; // True if data is older than 10 seconds
}

/**
 * LiveTable Component
 *
 * Displays realtime Redis data in a table format:
 * - Columns: Each source
 * - Rows: source_name row + channel rows
 *
 * Features:
 * - Load last 5s/30s or last 5 min (upwind/reaching/downwind) from Redis
 * - Updates cells smoothly without flashing
 * - Channel picker and source selection in sync with live map
 */
/** Last value per source/channel (value from Redis at latest timestamp). */
type LastValuesMap = Map<string, Record<string, number>>;

export default function LiveTable() {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [sources, setSources] = createSignal<string[]>([]);
  const [channels, setChannels] = createSignal<string[]>([]);
  const [displayChannels, setDisplayChannels] = createSignal<string[]>([]);
  const [showChannelPicker, setShowChannelPicker] = createSignal(false);
  /** Last value per source/channel (filled when user clicks Load last 5s/30s) */
  const [lastValues, setLastValues] = createSignal<LastValuesMap>(new Map());
  /** Single timestamp for badge: max across all points from last load */
  const [lastDatetimeMs, setLastDatetimeMs] = createSignal<number | null>(null);
  const [loadingAverages, setLoadingAverages] = createSignal(false);
  /** Last load window used (ms), for footer label: 5000 | 30000 | 300000 | null */
  const [lastLoadWindowMs, setLastLoadWindowMs] = createSignal<number | null>(null);
  /** Mode for last load: latest | upwind | reaching | downwind (only set when window is 5 min) */
  const [lastLoadMode, setLastLoadMode] = createSignal<LiveTableWindowMode | null>(null);

  let isMounted = true;

  const LIVE_TABLE_PARENT = 'live';
  const LIVE_TABLE_OBJECT = 'live_table';

  /** Load saved channel list from live_table user object; apply to displayChannels if present. */
  const loadLiveTableChannels = async (): Promise<void> => {
    const className = persistantStore.selectedClassName?.();
    const projectId = persistantStore.selectedProjectId?.();
    const currentUser = user();
    if (!className || projectId == null || !currentUser?.user_id) return;
    try {
      const url = `${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&user_id=${encodeURIComponent(currentUser.user_id)}&parent_name=${encodeURIComponent(LIVE_TABLE_PARENT)}&object_name=${encodeURIComponent(LIVE_TABLE_OBJECT)}`;
      const response = await getData(url);
      if (!isMounted) return;
      if (!response.success || response.data == null) return;
      let data: { channels?: string[] } = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      const saved = data?.channels;
      if (!Array.isArray(saved) || saved.length === 0) return;
      const validSet = new Set(LIVE_CHANNELS);
      const filtered = saved.filter((c) => validSet.has(c));
      if (filtered.length > 0) setDisplayChannels(filtered);
    } catch (err) {
      if (!isMounted) return;
      debug('[LiveTable] Load live_table channels (optional)', err);
    }
  };

  /** Load same source selection as live map: user settings (cross-device) first, then localStorage, then all. */
  const loadLiveMapSourcesIntoStore = async (verifiedSourceNames: string[]): Promise<void> => {
    if (!sourcesStore.isReady() || verifiedSourceNames.length === 0) return;
    const cls = persistantStore.selectedClassName?.() ?? '';
    const proj = persistantStore.selectedProjectId?.() ?? 0;
    const currentUser = user();
    const validIds = new Set(
      verifiedSourceNames
        .map((name) => sourcesStore.getSourceId(name))
        .filter((id): id is number => id != null)
    );
    if (validIds.size === 0) return;

    const storeKey = `${cls}_${proj}_live`;

    // 1) User settings (persistent across devices)
    if (cls && proj != null && currentUser?.user_id) {
      try {
        const url = `${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(cls)}&project_id=${encodeURIComponent(proj)}&user_id=${encodeURIComponent(currentUser.user_id)}&parent_name=${encodeURIComponent(LIVE_SOURCES_PARENT)}&object_name=${encodeURIComponent(LIVE_SOURCES_KEY)}`;
        const response = await getData(url);
        if (isMounted && response.success && response.data != null) {
          const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
          const ids = data?.source_ids;
          if (Array.isArray(ids) && ids.length > 0) {
            const restored = new Set(ids.map((id: unknown) => Number(id)).filter((id) => validIds.has(id)));
            if (restored.size > 0) {
              liveSourcesStore.setSelectedSourceIds(restored);
              debug('[LiveTable] Restored live sources from user settings', { count: restored.size });
              return;
            }
          }
        }
      } catch (err) {
        debug('[LiveTable] Load live_sources from user (optional)', err);
      }
    }

    // 2) LocalStorage (same browser)
    const saved = getStoredLiveSources();
    const savedIds = saved[storeKey];
    if (Array.isArray(savedIds) && savedIds.length > 0) {
      const restored = new Set(savedIds.map((id) => Number(id)).filter((id) => validIds.has(id)));
      if (restored.size > 0) {
        liveSourcesStore.setSelectedSourceIds(restored);
        debug('[LiveTable] Restored live sources from localStorage', { count: restored.size });
        return;
      }
    }

    // 3) Don't overwrite if the map has already set a selection (same view / store is shared)
    const current = liveSourcesStore.selectedSourceIds();
    const currentValid = current.size > 0 && Array.from(current).every((id) => validIds.has(id));
    if (currentValid) {
      debug('[LiveTable] No saved preference; keeping current live map selection', { count: current.size });
      return;
    }
    // Only set empty when store is empty (table opened first, or no selection yet)
    liveSourcesStore.setSelectedSourceIds(new Set());
    debug('[LiveTable] No saved live sources; starting with no sources selected');
  };

  /** Save channel list to live_table user object. */
  const saveLiveTableChannels = async (channelsList: string[]): Promise<void> => {
    const className = persistantStore.selectedClassName?.();
    const projectId = persistantStore.selectedProjectId?.();
    const currentUser = user();
    if (!className || projectId == null || !currentUser?.user_id) return;
    try {
      const payload = {
        class_name: className,
        project_id: Number(projectId),
        user_id: currentUser.user_id,
        parent_name: LIVE_TABLE_PARENT,
        object_name: LIVE_TABLE_OBJECT,
        json: JSON.stringify({ channels: channelsList })
      };
      const response = await postData(`${apiEndpoints.app.users}/object`, payload);
      if (!response.success) warn('[LiveTable] Save live_table channels failed', response.message);
    } catch (err) {
      warn('[LiveTable] Save live_table channels error', err);
    }
  };

  // Get available sources from streaming API (handles array or object with .sources / .data)
  const fetchSources = async (): Promise<string[]> => {
    try {
      const url = apiEndpoints.stream.sources;
      const response = await getData(url);

      if (!isMounted) return [];
      if (!response.success || response.data == null) return [];

      const raw = response.data;
      const arr: any[] = Array.isArray(raw)
        ? raw
        : (raw?.sources && Array.isArray(raw.sources)
          ? raw.sources
          : raw?.data && Array.isArray(raw.data)
            ? raw.data
            : []);

      const sourceNames = arr
        .map((s: any) => (typeof s === 'string' ? s : s?.source_name))
        .filter((name: string) => name != null && String(name).trim().length > 0)
        .map((name: string) => String(name).trim());
      return sourceNames.length > 0 ? [...new Set(sourceNames)].sort() : [];
    } catch (err) {
      if (!isMounted) return [];
      warn('[LiveTable] Error fetching sources (expected when streaming unavailable)', err);
      return [];
    }
  };

  // Get available channels from all sources (union)
  // Only returns channels matching pattern like "Vmg_kph" (uppercase, underscore, lowercase)
  /**
   * Fetch a sample data point from Redis to discover channels
   * Fetches merged data for common channels to get the full data object with all channels
   */
  /** Fetch project sources from main app API (same list as map/sidebar). */
  const fetchProjectSources = async (): Promise<string[]> => {
    const className = persistantStore.selectedClassName?.();
    const projectId = persistantStore.selectedProjectId?.();
    if (!className || projectId == null) return [];
    try {
      const url = `${apiEndpoints.app.sources}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}`;
      const response = await getData(url);
      if (!isMounted || !response.success || !Array.isArray(response.data)) return [];
      return response.data
        .map((s: any) => s?.source_name)
        .filter((n: string) => n != null && String(n).trim().length > 0)
        .map((n: string) => String(n).trim());
    } catch (err) {
      if (isMounted) debug('[LiveTable] fetchProjectSources failed', err);
      return [];
    }
  };

  /** Load sources list only (no WebSocket). Table data is loaded on demand via "Load 30s averages". */
  const initializeSources = async () => {
    if (!isMounted) return;
    try {
      setLoading(true);
      setError(null);
      let attempts = 0;
      const maxAttempts = 100;
      while (!sourcesStore.isReady() && attempts < maxAttempts && isMounted) {
        await new Promise((r) => setTimeout(r, 100));
        attempts++;
      }
      if (!isMounted) return;
      await loadLiveTableChannels();
      if (!isMounted) return;
      const [streamSourceNames, projectSourceNames] = await Promise.all([
        fetchSources(),
        fetchProjectSources()
      ]);
      if (!isMounted) return;
      const storeSourceNames = sourcesStore.isReady() ? sourcesStore.sources().map((s) => s.source_name) : [];
      const combined = [...new Set([...projectSourceNames, ...storeSourceNames, ...streamSourceNames])].filter(Boolean);
      if (combined.length === 0) {
        setError('No sources available. Please ensure streaming is active and sources are loaded.');
        setLoading(false);
        return;
      }
      const sourceList = combined.sort();
      setSources(sourceList);
      await loadLiveMapSourcesIntoStore(sourceList);
      if (!isMounted) return;
      setChannels([...LIVE_CHANNELS]);
      if (displayChannels().length === 0) setDisplayChannels([...LIVE_CHANNELS]);
      setLoading(false);
      debug('[LiveTable] Sources loaded (on-demand table)', { count: sourceList.length, project: projectSourceNames.length, store: storeSourceNames.length, stream: streamSourceNames.length });
    } catch (err) {
      if (!isMounted) return;
      logError('[LiveTable] Error loading sources', err);
      setError(err instanceof Error ? err.message : 'Failed to load sources');
      setLoading(false);
    }
  };

  const FIVE_SECONDS_MS = 5 * 1000;
  const THIRTY_SECONDS_MS = 30 * 1000;
  const META_KEYS = new Set(['timestamp', 'Datetime', 'datetime', 'source_name', 'source_id']);

  /** Fetch last N ms from Redis per source; compute last value per (source, channel) and one global last datetime for badge. */
  /** When mode is upwind/reaching/downwind, only points where Twa_deg is in that band are used (last 5 min of matching points). */
  const loadLastDatetimes = async (windowMs: number, mode?: LiveTableWindowMode) => {
    const sourceNames = tableSourceColumns().length > 0 ? tableSourceColumns() : sources();
    if (sourceNames.length === 0) {
      setError('No sources available. Wait for sources to load or ensure streaming is active.');
      return;
    }
    setLoadingAverages(true);
    setError(null);
    try {
      const endTime = Date.now();
      const startTime = endTime - windowMs;
      let channelList = channelsToDisplay().length > 0 ? channelsToDisplay() : LIVE_CHANNELS;
      const needsTwa = mode === 'upwind' || mode === 'reaching' || mode === 'downwind';
      if (needsTwa && !channelList.includes('Twa_deg')) {
        channelList = ['Twa_deg', ...channelList];
      }
      const results: LastValuesMap = new Map();
      let globalLastTs = 0;

      debug('[LiveTable] Fetching last values', {
        windowMs,
        mode: mode ?? 'latest',
        sourceCount: sourceNames.length,
        sources: sourceNames,
        channelCount: channelList.length,
        channels: channelList.slice(0, 10)
      });

      const perSource = await Promise.all(
        sourceNames.map(async (sourceName) => {
          const points = await streamingDataService.fetchMergedData(
            sourceName,
            channelList,
            startTime,
            endTime
          );
          if (!isMounted) return { sourceName, values: {} as Record<string, number>, maxTs: 0 };
          const toUse = needsTwa && mode
            ? points.filter((pt) => pointMatchesTwaMode(pt as Record<string, unknown>, mode))
            : points;
          // Points sorted by timestamp ascending; last point wins per channel
          const values: Record<string, number> = {};
          let maxTs = 0;
          for (const pt of toUse) {
            const ts = pt.timestamp;
            if (ts > maxTs) maxTs = ts;
            for (const key of Object.keys(pt)) {
              if (META_KEYS.has(key)) continue;
              const val = pt[key];
              if (val === null || val === undefined) continue;
              const num = typeof val === 'number' && Number.isFinite(val) ? val : (typeof val === 'string' && !isNaN(Number(val)) ? Number(val) : null);
              if (num !== null) values[key] = num;
            }
          }
          return { sourceName, values, maxTs };
        })
      );

      if (!isMounted) return;
      for (const { sourceName, values, maxTs } of perSource) {
        results.set(sourceName, values);
        if (maxTs > globalLastTs) globalLastTs = maxTs;
      }
      setLastValues(results);
      setLastDatetimeMs(globalLastTs > 0 ? globalLastTs : null);
      setLastLoadWindowMs(windowMs);
      setLastLoadMode(mode ?? null);
      debug('[LiveTable] Loaded last values', {
        windowMs,
        mode: mode ?? 'latest',
        sourceCount: results.size,
        sources: Array.from(results.keys()),
        globalLastTs: globalLastTs || null
      });
    } catch (err) {
      if (!isMounted) return;
      logError('[LiveTable] Error loading last values', err);
      setError(err instanceof Error ? err.message : 'Failed to load last values from Redis');
    } finally {
      if (isMounted) setLoadingAverages(false);
    }
  };

  // Filter sources for "Load 30s averages" (map selection); table columns always use sources() so columns never disappear
  const displaySources = createMemo(() => {
    const allSources = sources();
    const selectedIds = liveSourcesStore.selectedSourceIds();
    if (selectedIds.size === 0) return allSources;
    const selectedNames = new Set(
      Array.from(selectedIds)
        .map((id) => sourcesStore.getSourceName(id))
        .filter((n): n is string => !!n)
    );
    const filtered = allSources.filter((name) => selectedNames.has(name));
    return filtered.length > 0 ? filtered : allSources;
  });

  // Table columns: use displaySources so table stays in sync with live map selection (enabled/disabled sources)
  const tableSourceColumns = createMemo(() => {
    const filtered = displaySources();
    return filtered.length > 0 ? [...filtered] : [];
  });

  // When channels() is first populated and user hasn't customized, show all channels
  createEffect(() => {
    const all = channels();
    const disp = displayChannels();
    if (all.length > 0 && disp.length === 0) {
      setDisplayChannels([...all]);
    }
  });

  const channelsToDisplay = createMemo(() => {
    const disp = displayChannels();
    const all = channels();
    if (disp.length === 0) return all;
    return disp;
  });

  // Available channels for picker: canonical Redis/streaming list + any discovered at runtime
  const availableChannelsForPicker = createMemo(() => {
    const discovered = channels();
    const known = new Set(LIVE_CHANNELS);
    const extra = discovered.filter((c) => !known.has(c));
    return [...LIVE_CHANNELS, ...extra];
  });

  // Table rows from last values per source/channel (Redis values)
  const tableRows = createMemo((): TableRow[] => {
    const sourceNames = tableSourceColumns();
    const channelNames = channelsToDisplay();
    const valMap = lastValues();
    if (sourceNames.length === 0 || channelNames.length === 0) return [];
    const norm = (s: string) => s.toLowerCase().replace(/_/g, '');
    const rows: TableRow[] = [];
    for (const channel of channelNames) {
      const channelRow: TableRow = { rowType: 'channel', label: channel };
      for (const sourceName of sourceNames) {
        const srcVals = valMap.get(sourceName);
        let value: number | null = null;
        if (srcVals && channel in srcVals) value = srcVals[channel];
        if (value === undefined) {
          const key = Object.keys(srcVals || {}).find((k) => norm(k) === norm(channel));
          if (key && srcVals) value = srcVals[key];
        }
        channelRow[sourceName] = value;
        channelRow[`${sourceName}_age`] = null;
        channelRow[`${sourceName}_isStale`] = false;
        channelRow[`${sourceName}_updateKey`] = 0;
      }
      rows.push(channelRow);
    }
    return rows;
  });

  /** Per-row min/max for conditional formatting (scale by row). One entry per row index. */
  const rowScales = createMemo((): { min: number; max: number }[] => {
    const rows = tableRows();
    const sourceNames = tableSourceColumns();
    if (rows.length === 0 || sourceNames.length === 0) return [];
    return rows.map((row) => {
      const values = sourceNames
        .map((src) => row[src])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (values.length === 0) return { min: 0, max: 0 };
      const min = Math.min(...values);
      const max = Math.max(...values);
      return { min, max };
    });
  });

  /** Cell class c0–c6 for value-based formatting (blue = low, red = high) using this row's scale. */
  const getCellClassForRowValue = (
    value: string | number | null,
    rowIndex: number,
    scales: { min: number; max: number }[]
  ): string => {
    if (value == null || typeof value !== 'number' || !Number.isFinite(value)) return '';
    const scale = scales[rowIndex];
    if (!scale || scale.min === scale.max) return scale ? 'c3' : '';
    const x = (value - scale.min) / (scale.max - scale.min) * 6;
    const idx = Math.round(Math.max(0, Math.min(6, x)));
    return `c${idx}`;
  };

  // Format value for display: number/string (Redis value), or — if missing
  const formatValue = (value: string | number | null): string => {
    if (value === null || value === undefined) {
      return '—';
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return '—';
      if (Number.isInteger(value)) return value.toString();
      return Math.abs(value) < 1 ? value.toFixed(2) : value.toFixed(1);
    }
    return String(value);
  };

  // Format last datetime for badge (single timestamp at top)
  const formatLastDatetimeBadge = (): string => {
    const ts = lastDatetimeMs();
    const window = lastLoadWindowMs();
    const mode = lastLoadMode();
    if (ts == null || ts <= 0) return '';
    const d = new Date(ts);
    const h = d.getHours();
    const m = d.getMinutes();
    const s = d.getSeconds();
    const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    let windowLabel = '';
    if (window === FIVE_SECONDS_MS) windowLabel = ' (last 5s)';
    else if (window === THIRTY_SECONDS_MS) windowLabel = ' (last 30s)';
    else if (window === FIVE_MINUTES_MS) windowLabel = mode ? ` (last 5 min, ${mode})` : ' (last 5 min)';
    return `Last datetime: ${timeStr}${windowLabel}`;
  };

  const getCellValue = (value: string | number | null, updateKey: number): CellValue => ({
    value,
    formatted: formatValue(value),
    updateKey,
    isStale: false
  });

  onMount(() => {
    debug('[LiveTable] Mounting component');
    initializeSources();
  });

  onCleanup(() => {
    debug('[LiveTable] Unmounting component');
    isMounted = false;
  });

  return (
    <div class="realtime-table-root">
      <div class="realtime-table-header">
        <div class="realtime-table-header-left">
          <button
            type="button"
            class="settings-icon-container realtime-table-settings-btn"
            onClick={() => setShowChannelPicker(true)}
            aria-label="Configure channels"
            title="Configure channels"
          >
            <FiSettings size={20} />
          </button>
          <h2 class="realtime-table-title">Realtime Data Table</h2>
          <button
            type="button"
            class="realtime-table-load-averages-btn"
            onClick={() => loadLastDatetimes(FIVE_SECONDS_MS)}
            disabled={loadingAverages() || sources().length === 0}
            title="Load last datetimes from last 5 seconds of Redis data"
          >
            {loadingAverages() ? 'Loading…' : 'Load last 5 sec'}
          </button>
          <button
            type="button"
            class="realtime-table-load-averages-btn"
            onClick={() => loadLastDatetimes(THIRTY_SECONDS_MS)}
            disabled={loadingAverages() || sources().length === 0}
            title="Load last datetimes from last 30 seconds of Redis data"
          >
            {loadingAverages() ? 'Loading…' : 'Load last 30 sec'}
          </button>
          <span class="realtime-table-mode-sep" aria-hidden="true">|</span>
          <button
            type="button"
            classList={{
              'realtime-table-mode-btn': true,
              'realtime-table-mode-btn-selected': lastLoadWindowMs() === FIVE_MINUTES_MS && lastLoadMode() === 'upwind'
            }}
            onClick={() => loadLastDatetimes(FIVE_MINUTES_MS, 'upwind')}
            disabled={loadingAverages() || sources().length === 0}
            title="Last 5 minutes where 25° < |Twa_deg| < 75°"
          >
            Upwind
          </button>
          <button
            type="button"
            classList={{
              'realtime-table-mode-btn': true,
              'realtime-table-mode-btn-selected': lastLoadWindowMs() === FIVE_MINUTES_MS && lastLoadMode() === 'reaching'
            }}
            onClick={() => loadLastDatetimes(FIVE_MINUTES_MS, 'reaching')}
            disabled={loadingAverages() || sources().length === 0}
            title="Last 5 minutes where 75° < |Twa_deg| < 125°"
          >
            Reaching
          </button>
          <button
            type="button"
            classList={{
              'realtime-table-mode-btn': true,
              'realtime-table-mode-btn-selected': lastLoadWindowMs() === FIVE_MINUTES_MS && lastLoadMode() === 'downwind'
            }}
            onClick={() => loadLastDatetimes(FIVE_MINUTES_MS, 'downwind')}
            disabled={loadingAverages() || sources().length === 0}
            title="Last 5 minutes where 125° < |Twa_deg| < 160°"
          >
            Downwind
          </button>
          <Show when={lastValues().size > 0 && lastDatetimeMs() != null}>
            <span class="realtime-table-averages-badge">
              {formatLastDatetimeBadge()}
            </span>
          </Show>
        </div>
      </div>

      <Show when={showChannelPicker()}>
        <LiveChannelPicker
          isOpen={showChannelPicker()}
          onClose={() => setShowChannelPicker(false)}
          availableChannels={availableChannelsForPicker()}
          selectedChannels={displayChannels()}
          onSave={(list) => {
            setDisplayChannels(list);
            setShowChannelPicker(false);
            saveLiveTableChannels(list);
          }}
        />
      </Show>

      <Show when={loading()}>
        <div style="padding: 40px; text-align: center; color: #ccc;">
          Loading sources...
        </div>
      </Show>

      <Show when={!loading() && error()}>
        <div style="padding: 20px; text-align: center; color: red; background: #fee; border: 1px solid #fcc; border-radius: 4px;">
          Error: {error()}
        </div>
      </Show>

      <Show when={!loading() && !error() && sources().length > 0}>
        <div class="realtime-table-scroll-wrapper">
          <table class="realtime-data-table" style="width: 100%; border-collapse: collapse; font-size: 14px; background: #555; color: white;">
            <thead style="position: sticky; top: 0; background: #666; z-index: 10;">
              <tr>
                <th class="realtime-table-col-channel" style="padding: 12px; text-align: left; border: 1px solid #444; background: #666; color: white; font-weight: bold; position: sticky; left: 0; z-index: 11;">
                  Channel / Source
                </th>
                <For each={tableSourceColumns()}>
                  {(source) => (
                    <th class="realtime-table-col-source" style="padding: 12px; text-align: center; border: 1px solid #444; background: #666; color: white; font-weight: bold;">
                      {source}
                    </th>
                  )}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={tableRows()}>
                {(row, index) => (
                  <tr>
                    <td class="realtime-table-col-channel" style="padding: 10px; text-align: left; border: 1px solid #444; background: #5a5a5a; color: white; font-weight: bold; position: sticky; left: 0; z-index: 10;">
                      {row.label}
                    </td>
                    <For each={tableSourceColumns()}>
                      {(source) => {
                        const value = row[source] as string | number | null;
                        const updateKey = (row[`${source}_updateKey`] as number) ?? 0;
                        const cellValue = getCellValue(value, updateKey);
                        const scaleClass = getCellClassForRowValue(value, index(), rowScales());
                        return (
                          <td
                            class={`realtime-table-cell realtime-table-col-source ${scaleClass}`}
                            data-update-key={cellValue.updateKey}
                          >
                            {cellValue.formatted}
                          </td>
                        );
                      }}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>

        <div class="realtime-table-footer">
          {tableSourceColumns().length} source{tableSourceColumns().length !== 1 ? 's' : ''} • {channelsToDisplay().length} channel{channelsToDisplay().length !== 1 ? 's' : ''} • Load 5s/30s or Upwind / Reaching / Downwind (last 5 min) to refresh from Redis
        </div>
      </Show>

      <Show when={!loading() && !error() && tableSourceColumns().length === 0}>
        <div style="padding: 40px; text-align: center; color: #ccc;">
          No sources available. Please ensure streaming is active.
        </div>
      </Show>
    </div>
  );
}
