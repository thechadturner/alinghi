import { createEffect, createMemo, onMount, onCleanup, Show } from "solid-js";
import VideoComponent from "../../charts/Video";
import ManeuverPlayPause from "../../utilities/ManeuverPlayPause";
import { persistantStore } from "../../../store/persistantStore";
import { selection, selectedEvents } from "../../../store/selectionStore";
import { isPlaying, selectedTime, setSelectedTime, setManeuverVideoResetTrigger, maneuverVideoResetTrigger, maneuverVideoStartOffsetSeconds } from "../../../store/playbackStore";
import { tabledata } from "../../../store/globalStore";
import { registerActiveComponent, unregisterActiveComponent } from "../../../pages/Dashboard";
import { debug as logDebug } from "../../../utils/console";
import { getIndexColor } from "../../../utils/global";

const { selectedSourceName } = persistantStore;

const videoCellClass = "w-full h-full flex items-center justify-center overflow-hidden min-h-0";

export interface ManeuverVideoProps {
  context: string;
  onDataUpdate?: () => void;
  /** When true (e.g. in maneuver window), only show the video tile area and play/pause bar at the bottom; no other chrome. */
  tilesOnly?: boolean;
  [key: string]: unknown;
}

const MAX_VIDEO_TILES = 4;

/**
 * Maneuver video view: renders the chart Video component with the current
 * dataset source. When the user selects maneuvers, syncs playback time to
 * the first event's start_time. Uses only the first 4 selected events for video
 * (selection elsewhere is unchanged). Tiles: 1 = centered, 2 = stacked,
 * 3 = one column three rows, 4 = 2x2 grid. Play/pause is shown by Dashboard (time window hidden in this mode).
 */
export default function Video(props: ManeuverVideoProps) {
  const tilesOnly = () => props.tilesOnly === true;
  onMount(() => {
    registerActiveComponent("maneuvers-video");
    requestAnimationFrame(() => {
      if (tabledata().length > 0) {
        setManeuverVideoResetTrigger((t) => t + 1);
      }
    });
  });

  onCleanup(() => {
    unregisterActiveComponent("maneuvers-video");
  });

  // Get source name from a table row (fleet may use source_name, sourceName, Source_name, or source).
  const getSourceNameFromRow = (row: Record<string, unknown> | undefined): string | undefined => {
    if (!row) return undefined;
    const name = (row.source_name ?? row.sourceName ?? row.Source_name ?? row.source) as string | undefined;
    if (name != null && String(name).trim() !== "") return String(name).trim();
    return undefined;
  };

  // Video start_time = maneuver datetime (from row) + maneuverVideoStartOffsetSeconds. Reactive to user's chosen start offset.
  const getStartTimeFromRow = (row: Record<string, unknown> | undefined): string | undefined => {
    if (!row) return undefined;
    const raw = (row.datetime ?? row.Datetime ?? row.DATETIME ?? row.date ?? row.Date) as string | Date | undefined;
    if (raw == null) return undefined;
    let date: Date;
    if (typeof raw === "string" && raw.trim() !== "") {
      date = new Date(raw.trim());
    } else if (typeof raw === "object" && raw instanceof Date && !Number.isNaN(raw.getTime())) {
      date = raw;
    } else {
      return undefined;
    }
    if (Number.isNaN(date.getTime())) return undefined;
    const startMs = date.getTime() + maneuverVideoStartOffsetSeconds() * 1000;
    return new Date(startMs).toISOString();
  };

  // Memoized tile list: only recompute when selection or table data change, NOT when selectedTime ticks.
  // This prevents Video tiles from unmounting/remounting every second during playback.
  const tileList = createMemo((): Array<{ event_id: number; start_time?: string; twa_entry?: number; Twa_entry?: number; source_name?: string }> => {
    const ids = selectedEvents();
    const table = tabledata();
    const tableArr = Array.isArray(table) ? table : [];

    if (Array.isArray(ids) && ids.length > 0) {
      return ids.slice(0, MAX_VIDEO_TILES).map((eventId) => {
        const row = tableArr.find((r: { event_id?: number }) => r?.event_id == eventId) as Record<string, unknown> | undefined;
        const start_time = getStartTimeFromRow(row);
        const source_name = getSourceNameFromRow(row);
        return {
          event_id: Number(eventId),
          start_time,
          twa_entry: row?.twa_entry as number | undefined,
          Twa_entry: row?.Twa_entry as number | undefined,
          source_name,
        };
      });
    }

    const sel = selection();
    if (!Array.isArray(sel) || sel.length === 0) return [];
    return sel.slice(0, MAX_VIDEO_TILES).map((item: unknown) => {
      const eventId = item && typeof item === "object" && "event_id" in item
        ? (item as { event_id: number }).event_id
        : typeof item === "number"
          ? item
          : null;
      if (eventId == null) return { event_id: 0, start_time: undefined, twa_entry: undefined, Twa_entry: undefined, source_name: undefined };
      const row = tableArr.find((r: { event_id?: number }) => r?.event_id == eventId) as Record<string, unknown> | undefined;
      const start_time = getStartTimeFromRow(row);
      const source_name = getSourceNameFromRow(row);
      return {
        event_id: Number(eventId),
        start_time,
        twa_entry: row?.twa_entry as number | undefined,
        Twa_entry: row?.Twa_entry as number | undefined,
        source_name,
      };
    });
  });

  const selectionForVideo = () => tileList();

  // With 2+ tiles, selectedTime must stay first-event-based (logical offset -15 → 0 → 1 → 2...). Tile-internal times (e.g. 194s into a file) must never drive selectedTime.
  createEffect(() => {
    const sel = selectionForVideo();
    if (sel.length < 2) return;
    const first = sel[0];
    if (!first || typeof first !== "object" || typeof (first as { start_time?: string }).start_time !== "string") return;
    const clipStartStr = (first as { start_time: string }).start_time;
    try {
      const clipStartDate = new Date(clipStartStr);
      if (Number.isNaN(clipStartDate.getTime())) return;
      const st = selectedTime();
      if (!(st instanceof Date) || Number.isNaN(st.getTime())) return;
      const firstManeuverMs = clipStartDate.getTime() - maneuverVideoStartOffsetSeconds() * 1000;
      const elapsedSec = (st.getTime() - firstManeuverMs) / 1000;
      const offsetSec = maneuverVideoStartOffsetSeconds();
      // When paused: only accept values near init (e.g. -15 to +90s). Values like 192 are tile-internal → correct to init.
      // When playing: accept up to 1hr so playback is not interrupted.
      const maxElapsedWhenPaused = offsetSec + 90;
      const inLogicalRange = isPlaying()
        ? elapsedSec >= offsetSec - 5 && elapsedSec <= offsetSec + 3600
        : elapsedSec >= offsetSec - 5 && elapsedSec <= maxElapsedWhenPaused;
      if (inLogicalRange) return;
      setSelectedTime(clipStartDate, "maneuvers-video", true);
      logDebug("Maneuvers Video: corrected selectedTime to first-event clip start (was tile-internal or out of range)", { elapsedSec, offsetSec });
    } catch (_e) {
      // ignore
    }
  });

  // Sync selectedTime to first event's start_time only when the *first* event changes (not when just adding more videos). Keep tracking vars updated so pause/add don't falsely trigger a reset.
  let lastSyncedStartTimeMs: number | null = null;
  let lastSyncedLength = 0;
  createEffect(() => {
    const sel = selectionForVideo();
    if (sel.length === 0) {
      lastSyncedStartTimeMs = null;
      lastSyncedLength = 0;
      return;
    }
    const first = sel[0];
    if (!first || typeof first !== "object" || typeof (first as { start_time?: string }).start_time !== "string") return;
    const startTime = (first as { start_time: string }).start_time;
    try {
      const date = new Date(startTime);
      if (Number.isNaN(date.getTime())) return;
      const firstStartTimeMs = date.getTime();
      const lengthChanged = sel.length !== lastSyncedLength;
      const firstStartChanged = lastSyncedStartTimeMs === null || firstStartTimeMs !== lastSyncedStartTimeMs;
      // Always update tracking (even when playing) so that when we pause we don't falsely think selection changed
      lastSyncedStartTimeMs = firstStartTimeMs;
      lastSyncedLength = sel.length;
      // When first event changed: sync time and fire reset. When only adding a video (length changed): leave time alone but fire reset so the new tile seeks.
      if (firstStartChanged && !isPlaying()) {
        setSelectedTime(date, "maneuvers-video", true);
        logDebug("Maneuvers Video: synced selectedTime to first event start (first event changed)", { startTime });
      }
      if (firstStartChanged || lengthChanged) {
        setManeuverVideoResetTrigger((t) => t + 1);
        logDebug("Maneuvers Video: triggered seek (first event changed or new video added)", { firstStartChanged, lengthChanged });
      }
    } catch (_e) {
      // ignore invalid date
    }
  });

  const sourceName = () => {
    const name = selectedSourceName?.();
    if (name && String(name).trim() !== "" && String(name).toUpperCase() !== "ALL") {
      return String(name).trim();
    }
    return "Youtube";
  };

  // Per-tile source: use row source_name when present (fleet), else single source
  const sourceNameForIndex = (index: number): string => {
    const sel = selectionForVideo();
    const name = index >= 0 && index < sel.length ? sel[index]?.source_name : undefined;
    if (name && String(name).trim() !== "") return String(name).trim();
    const fallback = sourceName();
    if (props.context === "fleet") {
      logDebug("Maneuvers Video: no source_name on row for tile index " + index + ", using fallback: " + fallback);
    }
    return fallback;
  };

  // Only show video when user has explicitly selected table rows (selectedEvents). No fallback to selection().
  const hasSelectedEvents = () => {
    const ids = selectedEvents();
    return Array.isArray(ids) && ids.length > 0;
  };

  // Up to 4 tiles: only first 4 selected events are used for video
  const tileCount = () => {
    const sel = selectionForVideo();
    return sel.length;
  };

  const startTimeForIndex = (index: number): string | undefined => {
    const sel = selectionForVideo();
    if (index < 0 || index >= sel.length) return undefined;
    const item = sel[index];
    if (item && typeof item === "object" && typeof (item as { start_time?: string }).start_time === "string") {
      return (item as { start_time: string }).start_time;
    }
    return undefined;
  };

  // Raw maneuver date for tile index (row datetime, no offset). Used to compute currentTimeForTile = maneuver_i + (selectedTime - first_maneuver).
  const getManeuverDateForIndex = (index: number): Date | null => {
    const sel = selectionForVideo();
    if (index < 0 || index >= sel.length) return null;
    const ids = selectedEvents();
    const table = tabledata();
    const tableArr = Array.isArray(table) ? table : [];
    const eventId = sel[index]?.event_id;
    if (eventId == null) return null;
    const row = tableArr.find((r: { event_id?: number }) => r?.event_id === eventId) as Record<string, unknown> | undefined;
    const raw = row ? (row.datetime ?? row.Datetime ?? row.DATETIME ?? row.date ?? row.Date) as string | undefined : undefined;
    if (raw == null || (typeof raw === "string" && !raw.trim())) return null;
    const d = new Date(typeof raw === "string" ? raw.trim() : raw);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  // Per-tile current time so each tile steps/plays to (maneuver_i + offset). Reactive to selectedTime().
  const currentTimeForTileForIndex = (index: number): Date | string | undefined => {
    const first = getManeuverDateForIndex(0);
    const tileManeuver = getManeuverDateForIndex(index);
    if (first == null || tileManeuver == null) return undefined;
    const st = selectedTime();
    if (!(st instanceof Date) || Number.isNaN(st.getTime())) return undefined;
    const offsetMs = st.getTime() - first.getTime();
    return new Date(tileManeuver.getTime() + offsetMs);
  };

  // Mirror horizontally for P-S (port-to-starboard): twa_entry <= 0 means port entry
  const mirrorHorizontalForIndex = (index: number): boolean => {
    const sel = selectionForVideo();
    if (index < 0 || index >= sel.length) return false;
    const item = sel[index];
    const twaEntry = item.twa_entry;
    const twaEntryAlt = item.Twa_entry;
    const value = twaEntry != null ? Number(twaEntry) : twaEntryAlt != null ? Number(twaEntryAlt) : null;
    if (value === null) return false;
    return value <= 0;
  };

  // Same color as maneuver table row selection so video tile matches table row
  const outlineColorForIndex = (index: number): string => {
    const sel = selectionForVideo();
    if (index < 0 || index >= sel.length) return "transparent";
    const eventId = sel[index].event_id;
    return getIndexColor(selectedEvents(), eventId) ?? "transparent";
  };

  // Only pass a time when paused (for step buttons / sync). When playing, pass undefined — just play/pause; re-init uses fixedStartTime + seekToStartTrigger.
  const currentTimeForTileProp = (index: number): Date | string | undefined =>
    isPlaying() ? undefined : currentTimeForTileForIndex(index);

  // Stable wrapper so Solid keeps the same component instance per index; only props update (avoids remount/reload when selectedTime or isPlaying changes).
  function ManeuverVideoTile(props: { index: number }) {
    const i = props.index;
    return (
      <VideoComponent
        media_source={sourceNameForIndex(i)}
        fixedStartTime={startTimeForIndex(i)}
        currentTimeForTile={currentTimeForTileProp(i)}
        syncToSelectedTime={false}
        mirrorHorizontal={mirrorHorizontalForIndex(i)}
        seekToStartTrigger={maneuverVideoResetTrigger()}
        width="100%"
        height="100%"
        style="max-width: 100%; max-height: 100%; object-fit: contain;"
      />
    );
  }

  return (
    <div class="maneuver-video-container w-full h-full overflow-hidden bg-black flex flex-col">
      <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
        <Show
          when={!hasSelectedEvents()}
          fallback={
        <Show
          when={tileCount() === 1}
          fallback={
            <Show
              when={tileCount() === 2}
              fallback={
                <Show
                  when={tileCount() === 3}
                  fallback={
                    /* 4 tiles: 2 columns, 2 rows */
                    <div class="w-full h-full grid grid-cols-2 grid-rows-2 gap-px bg-black">
                      <div class={`${videoCellClass} maneuver-video-cell-outline`} style={{ "border-color": outlineColorForIndex(0) }}><ManeuverVideoTile index={0} /></div>
                      <div class={`${videoCellClass} maneuver-video-cell-outline`} style={{ "border-color": outlineColorForIndex(1) }}><ManeuverVideoTile index={1} /></div>
                      <div class={`${videoCellClass} maneuver-video-cell-outline`} style={{ "border-color": outlineColorForIndex(2) }}><ManeuverVideoTile index={2} /></div>
                      <div class={`${videoCellClass} maneuver-video-cell-outline`} style={{ "border-color": outlineColorForIndex(3) }}><ManeuverVideoTile index={3} /></div>
                    </div>
                  }
                >
                  {/* 3 tiles: one column, three rows */}
                  <div class="w-full h-full flex flex-col gap-px">
                    <div class={`${videoCellClass} flex-1 min-h-0 maneuver-video-cell-outline`} style={{ "border-color": outlineColorForIndex(0) }}><ManeuverVideoTile index={0} /></div>
                    <div class={`${videoCellClass} flex-1 min-h-0 maneuver-video-cell-outline`} style={{ "border-color": outlineColorForIndex(1) }}><ManeuverVideoTile index={1} /></div>
                    <div class={`${videoCellClass} flex-1 min-h-0 maneuver-video-cell-outline`} style={{ "border-color": outlineColorForIndex(2) }}><ManeuverVideoTile index={2} /></div>
                  </div>
                </Show>
              }
            >
              {/* 2 tiles: one on top, one below */}
              <div class="w-full h-full flex flex-col gap-px">
                <div class={`${videoCellClass} flex-1 min-h-0 maneuver-video-cell-outline`} style={{ "border-color": outlineColorForIndex(0) }}><ManeuverVideoTile index={0} /></div>
                <div class={`${videoCellClass} flex-1 min-h-0 maneuver-video-cell-outline`} style={{ "border-color": outlineColorForIndex(1) }}><ManeuverVideoTile index={1} /></div>
              </div>
            </Show>
          }
        >
          {/* 1 tile: centered; set mirrorHorizontal true for P-S maneuvers */}
          <div class="w-full h-full flex items-center justify-center overflow-hidden maneuver-video-cell-outline" style={{ "border-color": outlineColorForIndex(0) }}>
            <ManeuverVideoTile index={0} />
          </div>
        </Show>
          }
        >
          {/* No events selected: clear video, show empty state */}
          <div class="w-full h-full flex items-center justify-center overflow-hidden bg-black" />
        </Show>
      </div>
      <div class="maneuver-video-controls-row w-full flex justify-center flex-shrink-0 py-2">
        <ManeuverPlayPause position="inline-centered" allowFastFwd={true} />
      </div>
    </div>
  );
}
