import { createSignal, createEffect, onCleanup, Show, createMemo, untrack } from "solid-js";
import { persistantStore } from "../../../../store/persistantStore";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { sourcesStore } from "../../../../store/sourcesStore";
import {
  selectedSources as filterStoreSelectedSources,
  setSelectedSources,
  selectedRacesTimeseries,
  selectedLegsTimeseries,
} from "../../../../store/filterStore";
import { getProjectVideoSources } from "../../../../services/projectFiltersService";
import { setCurrentDataset, getCurrentDatasetTimezone } from "../../../../store/datasetTimezoneStore";
import { registerActiveComponent, unregisterActiveComponent } from "../../../../pages/Dashboard";
import { getData } from "../../../../utils/global";
import { apiEndpoints } from "@config/env";
import { debug as logDebug } from "../../../../utils/console";
import Loading from "../../../../components/utilities/Loading";
import VideoComponent from "../../../../components/charts/Video";
import PlayPause from "../../../../components/utilities/PlayPause";
import MultiMapTimeSeries from "../../../../components/charts/map/MultiMapTimeSeries";
import VideoSettings from "../../../../components/menus/VideoSettings";

const { selectedClassName, selectedProjectId, selectedDate, setSelectedPage, selectedPage, selectedSourceId, selectedSourceName } = persistantStore;

/**
 * Fetch source names that have video for the given date (from media table).
 * Returns canonical source names in API order; empty array on failure or no media.
 */
async function fetchSourcesWithVideoForDate(
  className: string,
  projectId: number,
  dateForApi: string
): Promise<string[]> {
  try {
    const response = await getData(
      `${apiEndpoints.media.sources}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateForApi)}`
    );
    if (!response?.success || !Array.isArray(response?.data)) return [];
    const list = response.data as { media_source?: string; id?: string; name?: string }[];
    const names: string[] = [];
    for (const r of list) {
      const raw = r.media_source ?? r.id ?? r.name ?? "";
      if (!raw) continue;
      const id = Number(raw);
      const name =
        Number.isFinite(id) && sourcesStore.getSourceName(id)
          ? sourcesStore.getSourceName(id)!
          : String(raw).trim();
      if (name) names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

interface FleetVideoProps {
  objectName?: string;
  /** When true, we are in split view: hide timeline unless the other panel is TimeSeries. */
  isInSplitView?: boolean;
  /** When in split view (right panel), the menu name of the main (left) panel. If it's Map, we hide our built-in PlayPause (Dashboard overlay on the map is used). */
  mainPanelMenu?: string | null;
  /** When in split view (left panel), the menu name of the right panel. Used to show timeline when other panel is TimeSeries. */
  rightPanelMenu?: string | null;
  [key: string]: any;
}

/** First 1-4 selected source names in list order for fleet video tiles */
type SourceNames = string[];

export default function FleetVideo(props: FleetVideoProps) {
  const objectName = () => props?.objectName || selectedPage() || "default";
  const isInSplitView = () => !!props?.isInSplitView;
  /** True when we are in the split (right) panel and the main (left) panel is Map → hide our PlayPause (Dashboard shows it on the map). */
  const isMapInMainPanel = () => {
    if (!isInSplitView()) return false;
    const menu = (props?.mainPanelMenu ?? "").toString().replace(/\s+/g, "").toLowerCase();
    return menu === "map";
  };
  /** True when the other panel (main when we're right, right when we're left) is TimeSeries — show timeline so user can change time and play/pause from video. */
  const isOtherPanelTimeSeries = () => {
    const other = (props?.mainPanelMenu ?? props?.rightPanelMenu ?? "").toString();
    const norm = other.replace(/\s+/g, "").toLowerCase();
    return norm.includes("timeseries") || norm === "timeseries";
  };
  const [isLoading, setIsLoading] = createSignal(true);
  const [sourceNames, setSourceNames] = createSignal<SourceNames>([]);
  const [isTimelineLoading, setIsTimelineLoading] = createSignal(false);
  const [isHoveringVideo, setIsHoveringVideo] = createSignal(false);
  const [isHoveringTimeline, setIsHoveringTimeline] = createSignal(false);
  const [raceOptions, setRaceOptions] = createSignal<(number | string)[]>([]);
  const [legOptions, setLegOptions] = createSignal<number[]>([]);
  /** Source names that have media for the selected date (for Video Settings dropdown). Populated by media/sources API. */
  const [sourcesWithMediaNames, setSourcesWithMediaNames] = createSignal<string[]>([]);

  // Load sources-with-media for the selected date so Video Settings only lists sources that have media
  createEffect(() => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = selectedDate();
    if (!className || !projectId || !date || String(date).trim() === "") {
      setSourcesWithMediaNames([]);
      return;
    }
    const dateStr = String(date).trim();
    const dateForApi =
      dateStr.length === 8 && !dateStr.includes("-")
        ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
        : dateStr;
    let cancelled = false;
    fetchSourcesWithVideoForDate(className, Number(projectId), dateForApi).then((names) => {
      if (!cancelled) setSourcesWithMediaNames(names);
    }).catch(() => {
      if (!cancelled) setSourcesWithMediaNames([]);
    });
    return () => {
      cancelled = true;
    };
  });

  // Load race/leg options for Video Settings (same as map/timeseries)
  createEffect(() => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = selectedDate();
    if (!className || !projectId || !date || String(date).trim() === "") return;
    unifiedDataStore.getFilterOptions().then((opts) => {
      if (!opts) return;
      const races = (opts.races || []).slice().sort((a: number, b: number) => a - b);
      const legs = (opts.legs || opts.legOptions || []).slice().sort((a: number, b: number) => a - b);
      setRaceOptions(races.map(String));
      setLegOptions(legs);
      logDebug("FleetVideo: Loaded race/leg options for Video Settings", { raceCount: races.length, legCount: legs.length });
    }).catch(() => {});
  });

  // Video Settings: data source options restricted to sources that have media for the selected date
  const dataSourcesOptions = createMemo(() => {
    if (!sourcesStore.isReady()) return [];
    const projectSources = sourcesStore.sources();
    if (!projectSources?.length) return [];
    const withMedia = sourcesWithMediaNames();
    const withMediaSet = new Set(withMedia.map((n) => String(n).trim().toLowerCase()));
    const filtered = withMediaSet.size > 0
      ? projectSources.filter((s) => withMediaSet.has((s.source_name || "").trim().toLowerCase()))
      : [];
    if (!filtered.length) return [];
    return untrack(() =>
      filtered
        .map((s) => {
          const id = Number(s.source_id);
          if (!Number.isFinite(id)) return null;
          const name = s.source_name || "";
          const getter = () =>
            filterStoreSelectedSources().some(
              (n) => String(n).trim().toLowerCase() === name.trim().toLowerCase()
            );
          const setter = (value: boolean) => {
            const current = filterStoreSelectedSources();
            if (value) {
              if (!current.some((n) => String(n).trim().toLowerCase() === name.trim().toLowerCase())) {
                setSelectedSources([...current, name]);
              }
            } else {
              setSelectedSources(current.filter((n) => String(n).trim().toLowerCase() !== name.trim().toLowerCase()));
            }
          };
          return {
            key: `source-${id}`,
            label: name || `Source ${id}`,
            type: "toggle" as const,
            signal: [getter, setter] as [() => boolean, (value: boolean) => void],
          };
        })
        .filter((opt): opt is NonNullable<typeof opt> => opt !== null)
    );
  });

  if (objectName() && objectName() !== "default") {
    setSelectedPage(objectName());
  }

  const mediaDateYmd = createMemo(() => {
    const dateStr = selectedDate();
    if (!dateStr || String(dateStr).trim() === "") return null;
    const ymd = String(dateStr).replace(/[-/]/g, "").trim();
    return ymd.length >= 8 ? ymd.slice(0, 8) : null;
  });

  // Preload events for the day into agg.events so TimeSeriesSettings sees races/legs (non-blocking)
  createEffect(() => {
    const date = selectedDate();
    const className = selectedClassName();
    const projectId = selectedProjectId();
    if (!date || !className || !projectId || String(date).trim() === "") return;
    const dateStrNorm =
      String(date).length === 8 && !String(date).includes("-")
        ? `${String(date).slice(0, 4)}-${String(date).slice(4, 6)}-${String(date).slice(6, 8)}`
        : String(date);
    unifiedDataStore.preloadEventsForDate(className, Number(projectId), dateStrNorm).catch(() => {});
  });

  // Set dataset timezone for selected date so Video component uses local (dataset) time like explore/video page
  createEffect(async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = selectedDate();
    if (!className || !projectId || !date || String(date).trim() === "") {
      await setCurrentDataset(className || "", projectId || 0, null);
      return;
    }
    try {
      const ymd = String(date).replace(/[-/]/g, "");
      const timezoneResponse = await getData(
        `${apiEndpoints.app.datasets}/date/timezone?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(ymd)}`
      );
      const timezoneData = timezoneResponse?.data || timezoneResponse || {};
      const timezone = timezoneData.timezone;
      const datasetId = timezoneData.dataset_id;
      if (timezone && datasetId) {
        await setCurrentDataset(className, projectId, datasetId);
        logDebug("FleetVideo: Set timezone from date endpoint for media (local time)", {
          datasetId,
          timezone: getCurrentDatasetTimezone(),
        });
      } else {
        await setCurrentDataset(className, projectId, null);
      }
    } catch (error: unknown) {
      logDebug("FleetVideo: Error setting timezone for date", error as Error);
      await setCurrentDataset(className, projectId, null);
    }
  });

  createEffect(() => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = selectedDate();
    const filterNames = filterStoreSelectedSources();
    const sourcesReady = sourcesStore.isReady();
    const sourcesList = sourcesStore.sources();
    if (!className || !projectId || !date) {
      setSourceNames([]);
      return;
    }

    const filterNamesTrimmed = Array.isArray(filterNames)
      ? filterNames.map((n) => String(n).trim()).filter((n) => n.length > 0)
      : [];

    // When we have filter selection, resolve and set source names synchronously so video tiles and timeline update immediately (no async race).
    if (filterNamesTrimmed.length > 0 && sourcesReady && sourcesList.length > 0) {
      const nameToCanonical = new Map<string, string>(
        sourcesList.map((s) => [String(s.source_name).toLowerCase().trim(), s.source_name])
      );
      const names: string[] = [];
      for (const name of filterNamesTrimmed.slice(0, 4)) {
        const canonical = nameToCanonical.get(name.toLowerCase().trim());
        if (canonical) names.push(canonical);
      }
      logDebug("FleetVideo: Using filterStore selected sources (same as map)", {
        count: names.length,
        names,
        filterCount: filterNamesTrimmed.length,
        resolved: names.length === filterNamesTrimmed.length,
      });
      setSourceNames(names);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        let names: string[] = [];

        if (cancelled) return;

        // No filter selection: use project_objects video_sources (intersected with sources that have video), or first 1–4 from media/sources
        if (filterNamesTrimmed.length === 0) {
          const dateStr = String(date).trim();
          const dateForApi =
            dateStr.length === 8 && !dateStr.includes("-")
              ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
              : dateStr || "1970-01-01";

          const sourcesWithVideo = await fetchSourcesWithVideoForDate(className, Number(projectId), dateForApi);
          if (cancelled) return;

          // Step A: project_objects video_sources — intersect with sources that have video for this date
          const projectVideo = await getProjectVideoSources(className, Number(projectId), dateForApi);
          if (cancelled) return;
          if ((projectVideo?.source_names?.length ?? 0) > 0) {
            const videoSet = new Set(sourcesWithVideo.map((n) => n.trim().toLowerCase()));
            const intersection = projectVideo.source_names
              .filter((n) => videoSet.has(String(n).trim().toLowerCase()))
              .slice(0, 4);
            if (intersection.length > 0) {
              setSourceNames(intersection);
              setSelectedSources(intersection);
              logDebug("FleetVideo: Applied video_sources from project_objects (intersected with sources that have video)", {
                count: intersection.length,
              });
              if (!cancelled) setIsLoading(false);
              return;
            }
            // Intersection empty (saved sources have no video on this date) — fall through to first 1–4 from media/sources
          }

          // Step B: use first 1–4 sources that have video for this date
          if (sourcesWithVideo.length > 0) {
            const first = sourcesWithVideo.slice(0, 4);
            names.push(...first);
            setSelectedSources(first);
            logDebug("FleetVideo: Using first sources with video for date", { count: names.length });
          } else {
            // Step C: no media/sources for date — default to persistent selected source if set (single tile)
            const sid = selectedSourceId?.();
            const sname = selectedSourceName?.();
            const hasSelectedSource =
              (typeof sid === "number" && Number.isFinite(sid) && sid > 0) ||
              (typeof sname === "string" && sname.trim() !== "" && sname !== "ALL");
            if (hasSelectedSource && sourcesReady && sourcesList.length > 0) {
              let selectedName: string | null = null;
              if (typeof sid === "number" && sid > 0) {
                selectedName = sourcesStore.getSourceName(sid);
              }
              if (!selectedName && typeof sname === "string" && sname.trim() !== "") {
                const canonical = sourcesList.find(
                  (s) => String(s.source_name).trim().toLowerCase() === String(sname).trim().toLowerCase()
                );
                selectedName = canonical?.source_name ?? null;
              }
              if (selectedName) {
                names.push(selectedName);
                setSelectedSources([selectedName]);
                logDebug("FleetVideo: Defaulting to selected source (no video for date)", { sourceName: selectedName });
              }
            }
            if (names.length === 0) {
              logDebug("FleetVideo: No sources with video for date, showing empty state", { dateForApi });
            }
          }
          // If names still empty here → show "No video available."
        } else {
          // We have a selection (e.g. from video_sources or filterStore) but skipped the sync branch
          // (e.g. sources not ready yet in split view). Re-read store and resolve once ready.
          const ready = sourcesStore.isReady();
          const list = sourcesStore.sources();
          if (ready && list.length > 0) {
            const nameToCanonical = new Map<string, string>(
              list.map((s) => [String(s.source_name).toLowerCase().trim(), s.source_name])
            );
            const resolved: string[] = [];
            for (const name of filterNamesTrimmed.slice(0, 4)) {
              const canonical = nameToCanonical.get(name.toLowerCase().trim());
              if (canonical) resolved.push(canonical);
            }
            if (!cancelled) {
              setSourceNames(resolved);
              logDebug("FleetVideo: Resolved selected sources (async, e.g. split view)", {
                count: resolved.length,
                names: resolved,
              });
            }
            if (!cancelled) setIsLoading(false);
            return;
          }
          // Selection exists but sources not ready yet; don't overwrite with [] — effect will re-run when sources load
          if (!cancelled) setIsLoading(false);
          return;
        }

        if (!cancelled) setSourceNames(names);
      } catch (e) {
        logDebug("FleetVideo: Error loading selected sources", e as Error);
        setSourceNames([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  onCleanup(() => {
    unregisterActiveComponent("video");
  });

  createEffect(() => {
    if (sourceNames().length > 0) {
      registerActiveComponent("video");
    } else {
      unregisterActiveComponent("video");
    }
  });

  const count = () => sourceNames().length;
  const sources = () => sourceNames();

  /** Source IDs for the timeline (same sources as video tiles); used by MultiMapTimeSeries for fleet data */
  const fleetSourceIds = createMemo(() => {
    const names = sourceNames();
    const ids = new Set<number>();
    for (const name of names) {
      const id = sourcesStore.getSourceId(name);
      if (id != null && Number.isFinite(id)) ids.add(id);
    }
    return ids;
  });

  const renderVideoTile = (sourceName: string, drivesPlaybackTime?: boolean) => (
    <div class="fleet-video-tile w-full h-full flex items-center justify-center overflow-hidden">
      <VideoComponent
        media_source={sourceName}
        mediaDateYmd={mediaDateYmd() ?? undefined}
        width="100%"
        height="100%"
        style="max-width: 100%; max-height: 100%; object-fit: contain;"
        drivesPlaybackTime={drivesPlaybackTime}
      />
    </div>
  );

  const renderLayout = () => {
    const n = count();
    const list = sources();

    if (n === 1) {
      return (
        <div class="fleet-video-layout-1 w-full h-full flex items-center justify-center overflow-hidden">
          {renderVideoTile(list[0], true)}
        </div>
      );
    }

    if (n === 2) {
      return (
        <div class="fleet-video-layout-2 w-full h-full grid grid-rows-2 overflow-hidden">
          <div class="w-full h-full flex items-center justify-center overflow-hidden">
            {renderVideoTile(list[0], true)}
          </div>
          <div class="w-full h-full flex items-center justify-center overflow-hidden">
            {renderVideoTile(list[1], false)}
          </div>
        </div>
      );
    }

    if (n === 3) {
      return (
        <div class="fleet-video-layout-3 w-full h-full grid grid-cols-2 grid-rows-2 overflow-hidden">
          <div class="w-full h-full flex items-center justify-center overflow-hidden">
            {renderVideoTile(list[0], true)}
          </div>
          <div class="w-full h-full flex items-center justify-center overflow-hidden">
            {renderVideoTile(list[1], false)}
          </div>
          <div class="w-full h-full flex items-center justify-center overflow-hidden">
            {renderVideoTile(list[2], false)}
          </div>
          <div class="fleet-video-empty-cell w-full h-full bg-[var(--color-bg-card)]" aria-hidden="true" />
        </div>
      );
    }

    if (n >= 4) {
      return (
        <div class="fleet-video-layout-4 w-full h-full grid grid-cols-2 grid-rows-2 overflow-hidden">
          {list.slice(0, 4).map((name, index) => (
            <div class="w-full h-full flex items-center justify-center overflow-hidden">
              {renderVideoTile(name, index === 0)}
            </div>
          ))}
        </div>
      );
    }

    return null;
  };

  return (
    <div id="fleet-video-container" class="fleet-video-container flex flex-col w-full h-full min-h-0">
      <div class="video-page-container flex flex-col flex-1 min-h-0 w-full">
        <Show when={isLoading()}>
          <Loading />
        </Show>

        <Show when={!isLoading() && count() > 0}>
          <div
            class="video-area flex-1 min-h-0 w-full relative overflow-hidden"
            onMouseEnter={() => setIsHoveringVideo(true)}
            onMouseLeave={() => setIsHoveringVideo(false)}
          >
            <div class="w-full h-full overflow-hidden">
              {renderLayout()}
            </div>
            {/* Settings icon in upper right, visible when hovering over video */}
            <div
              class="fleet-video-settings-corner"
              classList={{ "fleet-video-settings-corner-visible": isHoveringVideo() }}
              aria-hidden={!isHoveringVideo()}
            >
              <VideoSettings
                dataSourcesOptions={dataSourcesOptions()}
                useIconTrigger={true}
                filterConfig={{ showRaces: true, showLegs: true }}
                raceOptions={raceOptions()}
                legOptions={legOptions()}
                selectedRaces={() => selectedRacesTimeseries()}
                selectedLegs={() => selectedLegsTimeseries().map((l) => Number(l)).filter((n) => !isNaN(n))}
              />
            </div>
          </div>
        </Show>

        <Show when={!isLoading() && count() === 0}>
          <div class="flex-1 min-h-0 w-full flex items-center justify-center">
            <div class="text-center">
              <p class="text-[var(--color-text-secondary)]">No video available.</p>
            </div>
          </div>
        </Show>

        {/* Timeline section: timeline with play/pause overlay (visible on hover). Show when not in split view, or when split with TimeSeries so user can change time and play/pause from video. */}
        <Show when={!isLoading() && count() > 0 && (!isInSplitView() || isOtherPanelTimeSeries())}>
          <div
            class="fleet-video-timeline-section fleet-video-timeline-section-compact"
            style="flex-shrink: 0; width: 100%; display: flex; flex-direction: column; border-top: 1px solid var(--color-border-primary); position: relative; z-index: 20;"
            onMouseEnter={() => setIsHoveringTimeline(true)}
            onMouseLeave={() => setIsHoveringTimeline(false)}
          >
            <div
              class="video-timeline-container"
              style="flex-shrink: 0; width: 100%; height: 120px; background: var(--color-bg-card); position: relative;"
            >
            <Show when={isTimelineLoading()}>
              <div
                class="video-timeline-loading-overlay"
                style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--color-bg-card); z-index: 15;"
              >
                <Loading message="Loading timeline..." />
              </div>
            </Show>
            <MultiMapTimeSeries
              maptype="DEFAULT"
              samplingFrequency={1}
              onMapUpdate={() => {}}
              videoOnly={true}
              brushEnabled={false}
              onLoadingChange={(loading) => setIsTimelineLoading(loading)}
              selectedSourceIds={fleetSourceIds()}
              selectedRacesTimeseries={selectedRacesTimeseries()}
              selectedLegsTimeseries={selectedLegsTimeseries()}
            />
            <div class={`timeline-controls-overlay${isHoveringTimeline() ? " timeline-controls-overlay-visible" : ""}`}>
              <PlayPause position="timeline-overlay" allowFastFwd={true} allowTimeWindow={true} />
            </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
