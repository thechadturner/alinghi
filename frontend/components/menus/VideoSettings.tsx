import { createSignal, createEffect, Show, createMemo } from "solid-js";
import { Portal } from "solid-js/web";
import { FiSettings } from "solid-icons/fi";
import { persistantStore } from "../../store/persistantStore";
import { sourcesStore } from "../../store/sourcesStore";
import { user } from "../../store/userStore";
import { debug, info } from "../../utils/console";
import { postData } from "../../utils/global";
import { apiEndpoints } from "@config/env";
import { formatRaceForDisplay, isSameRace } from "../../utils/raceValueUtils";

export interface VideoSettingsDataSourcesOption {
  key?: string;
  label?: string;
  name?: string;
  signal?: [() => boolean, (value: boolean) => void];
}

interface VideoSettingsProps {
  dataSourcesOptions?: VideoSettingsDataSourcesOption[];
  useIconTrigger?: boolean;
  /** When set with showRaces/showLegs, show race and leg filter chips (same store as map/timeseries). */
  filterConfig?: { showRaces?: boolean; showLegs?: boolean };
  raceOptions?: (number | string)[];
  legOptions?: number[];
  selectedRaces?: (number | string)[] | (() => (number | string)[]);
  selectedLegs?: number[] | (() => number[]);
}

function isAdminOrPublisher(): boolean {
  const u = user();
  if (!u?.permissions) return false;
  const perms = Array.isArray(u.permissions) ? u.permissions : [u.permissions];
  return perms.includes("administrator") || perms.includes("publisher");
}

export default function VideoSettings(props: VideoSettingsProps) {
  const [showPopup, setShowPopup] = createSignal(false);
  const [localSourceSelections, setLocalSourceSelections] = createSignal<Set<number>>(new Set());
  const [initialSourceSelections, setInitialSourceSelections] = createSignal<Set<number>>(new Set());
  const [localRaceSelections, setLocalRaceSelections] = createSignal<Set<number | string>>(new Set());
  const [localLegSelections, setLocalLegSelections] = createSignal<Set<number>>(new Set());
  const [initialRaceSelections, setInitialRaceSelections] = createSignal<Set<number | string>>(new Set());
  const [initialLegSelections, setInitialLegSelections] = createSignal<Set<number>>(new Set());
  const [saveDefaultSuccessFlash, setSaveDefaultSuccessFlash] = createSignal(false);

  const getSelectedRaces = (): (number | string)[] => {
    const r = props.selectedRaces;
    return Array.isArray(r) ? r : (typeof r === "function" ? r() : []);
  };
  const getSelectedLegs = (): number[] => {
    const l = props.selectedLegs;
    return Array.isArray(l) ? l : (typeof l === "function" ? l() : []);
  };

  let lastPopupState = false;
  createEffect(() => {
    const isOpen = showPopup();
    const options = props.dataSourcesOptions;
    const hasOptions = Array.isArray(options) && options.length > 0;
    const hasFilter = props.filterConfig?.showRaces || props.filterConfig?.showLegs;

    if (isOpen && !lastPopupState) {
      if (hasOptions) {
        const currentSelections = new Set<number>();
        options.forEach((opt) => {
          if (opt.key?.startsWith("source-")) {
            const match = opt.key.match(/source-(\d+)/);
            if (match) {
              const sourceId = Number(match[1]);
              try {
                const isSelected = opt.signal?.[0]?.() ?? false;
                if (isSelected) currentSelections.add(sourceId);
              } catch {
                // ignore
              }
            }
          }
        });
        const currentSet = new Set<number>(currentSelections);
        setLocalSourceSelections(currentSet);
        setInitialSourceSelections(new Set<number>(currentSet));
        debug("VideoSettings: Initialized local source selections", { count: currentSet.size });
      }
      if (hasFilter) {
        const races = getSelectedRaces();
        const legs = getSelectedLegs();
        setLocalRaceSelections(new Set(races));
        setLocalLegSelections(new Set(legs));
        setInitialRaceSelections(new Set(races));
        setInitialLegSelections(new Set(legs));
      }
    } else if (!isOpen && lastPopupState) {
      setLocalSourceSelections(new Set<number>());
      setInitialSourceSelections(new Set<number>());
      setLocalRaceSelections(new Set());
      setLocalLegSelections(new Set());
      setInitialRaceSelections(new Set());
      setInitialLegSelections(new Set());
      debug("VideoSettings: Reset local selections on modal close");
    }
    lastPopupState = isOpen;
  });

  const hasSourceChanges = createMemo(() => {
    if (!showPopup() || !Array.isArray(props.dataSourcesOptions) || props.dataSourcesOptions.length === 0) {
      return false;
    }
    const current = localSourceSelections();
    const initial = initialSourceSelections();
    if (current.size !== initial.size) return true;
    for (const id of current) {
      if (!initial.has(id)) return true;
    }
    for (const id of initial) {
      if (!current.has(id)) return true;
    }
    return false;
  });

  const hasFilterChanges = createMemo(() => {
    if (!showPopup() || (!props.filterConfig?.showRaces && !props.filterConfig?.showLegs)) return false;
    const cr = localRaceSelections();
    const cl = localLegSelections();
    const ir = initialRaceSelections();
    const il = initialLegSelections();
    if (cr.size !== ir.size || cl.size !== il.size) return true;
    for (const r of cr) {
      if (!Array.from(ir).some((x) => isSameRace(x, r))) return true;
    }
    for (const r of ir) {
      if (!Array.from(cr).some((x) => isSameRace(x, r))) return true;
    }
    for (const l of cl) {
      if (!il.has(l)) return true;
    }
    for (const l of il) {
      if (!cl.has(l)) return true;
    }
    return false;
  });

  const hasAnyChanges = () => hasSourceChanges() || hasFilterChanges();

  const resolveLocalSelectionToNames = (): string[] => {
    const sourceSelections = localSourceSelections();
    if (!Array.isArray(props.dataSourcesOptions) || props.dataSourcesOptions.length === 0) return [];
    return Array.from(sourceSelections)
      .map((sourceId) => {
        const source = sourcesStore.sources().find((s: { source_id: number }) => Number(s.source_id) === sourceId);
        return source?.source_name ?? sourcesStore.getSourceName?.(sourceId) ?? "";
      })
      .filter(Boolean);
  };

  const handleApplyChanges = async () => {
    const sourceSelections = localSourceSelections();
    const sourceNames = resolveLocalSelectionToNames();
    debug("VideoSettings: Applying source changes", { count: sourceNames.length, names: sourceNames });
    const { setSelectedSources, setSelectedRacesTimeseries, setSelectedLegsTimeseries } = await import("../../store/filterStore");
    setSelectedSources(sourceNames);
    setInitialSourceSelections(new Set(sourceSelections));

    if (props.filterConfig?.showRaces || props.filterConfig?.showLegs) {
      const raceSelections = localRaceSelections();
      const legSelections = localLegSelections();
      const raceStrings = Array.from(raceSelections).map((r) =>
        r === "TRAINING" || r === "training" || r === -1 || r === "-1" ? "TRAINING" : String(r)
      );
      const legStrings = Array.from(legSelections).map((l) => String(l));
      setSelectedRacesTimeseries(raceStrings);
      setSelectedLegsTimeseries(legStrings);
      setInitialRaceSelections(new Set(raceSelections));
      setInitialLegSelections(new Set(legSelections));
      debug("VideoSettings: Applied race/leg filters", { races: raceStrings, legs: legStrings });
    }
  };

  const handleSaveAsDefault = async () => {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    if (!className || !projectId) {
      debug("VideoSettings: Save as default skipped - no class or project");
      return;
    }
    const sourceNames = resolveLocalSelectionToNames();
    if (sourceNames.length === 0) {
      debug("VideoSettings: Save as default skipped - no sources selected");
      return;
    }
    // Use selected date (day view) so save goes to the visible date; fallback to project default
    const rawDate = (persistantStore.selectedDate?.() || "").trim();
    const dateToSave = (() => {
      if (!rawDate) return "1970-01-01";
      const d = rawDate;
      if (d.length === 8 && !d.includes("-")) {
        return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      }
      return d;
    })();
    try {
      const response = await postData(`${apiEndpoints.app.projects}/object`, {
        class_name: className,
        project_id: projectId,
        date: dateToSave,
        object_name: "video_sources",
        json: JSON.stringify({ source_names: sourceNames }),
      });
      if (response?.success) {
        debug("VideoSettings: Saved video_sources to project_objects", {
          count: sourceNames.length,
          date: dateToSave,
        });
        setSaveDefaultSuccessFlash(true);
        setTimeout(() => setSaveDefaultSuccessFlash(false), 1200);
        // Also apply to filterStore and close so grid updates
        const { setSelectedSources } = await import("../../store/filterStore");
        setSelectedSources(sourceNames);
        setInitialSourceSelections(new Set(localSourceSelections()));
        setShowPopup(false);
      }
    } catch (err) {
      debug("VideoSettings: Error saving video_sources", err);
    }
  };

  const handleDisplayOptionClick = (option: VideoSettingsDataSourcesOption) => {
    try {
      info("VideoSettings: Source clicked", { key: option.key });
    } catch {}
    if (!option.key?.startsWith("source-") || !option.signal?.length) return;
    const match = option.key.match(/source-(\d+)/);
    if (!match) return;
    const sourceId = Number(match[1]);
    const current = localSourceSelections();
    const next = new Set(current);
    if (next.has(sourceId)) next.delete(sourceId);
    else next.add(sourceId);
    setLocalSourceSelections(next);
    debug("VideoSettings: Source toggle", { sourceId, selected: next.has(sourceId) });
  };

  const handleRaceClick = (race: number | string) => {
    const current = localRaceSelections();
    const next = new Set(current);
    const has = Array.from(current).some((r) => isSameRace(r, race));
    if (has) {
      Array.from(current).forEach((r) => {
        if (isSameRace(r, race)) next.delete(r);
      });
    } else {
      next.add(race);
    }
    setLocalRaceSelections(next);
    debug("VideoSettings: Race toggle", { race, selected: !has });
  };

  const handleLegClick = (leg: number) => {
    const current = localLegSelections();
    const next = new Set(current);
    if (next.has(leg)) next.delete(leg);
    else next.add(leg);
    setLocalLegSelections(next);
    debug("VideoSettings: Leg toggle", { leg, selected: next.has(leg) });
  };

  const handleClearRaceLeg = () => {
    setLocalRaceSelections(new Set());
    setLocalLegSelections(new Set());
    debug("VideoSettings: Cleared race/leg filters");
  };

  const visibleLegOptions = (): number[] =>
    (props.legOptions || []).filter((leg: number) => !isNaN(leg) && leg !== null && leg !== undefined && Number(leg) > -1);
  const raceOptionsFiltered = (): (number | string)[] =>
    (props.raceOptions || []).filter(
      (race: number | string) =>
        race !== null &&
        race !== undefined &&
        (race === "TRAINING" || race === "training" || !isNaN(Number(race)))
    );

  return (
    <>
      <div class="relative inline-block settings-parent timeseries-settings-wrapper">
        <Show
          when={props.useIconTrigger}
          fallback={
            <button
              type="button"
              onClick={() => {
                const next = !showPopup();
                setShowPopup(next);
              }}
              onContextMenu={(e) => e.preventDefault()}
              class="dropdown py-2 px-3 rounded-md flex flex-col items-center forced-medium"
              style="background: var(--color-bg-button); color: var(--color-text-inverse); transition: all 0.3s ease;"
            >
              <span class="self-start text-xs font-medium">Settings</span>
              <span class="text-sm font-bold">Video</span>
            </button>
          }
        >
          <div
            class="timeseries-settings-icon cursor-pointer p-1 hover:opacity-70 transition-opacity"
            onClick={() => {
              const next = !showPopup();
              setShowPopup(next);
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <FiSettings size={24} />
          </div>
        </Show>
      </div>

      <Show when={showPopup()}>
        <Portal mount={typeof document !== "undefined" ? document.body : undefined}>
          <div class="pagesettings-overlay">
            <div class="pagesettings-modal" onClick={(e) => e.stopPropagation()}>
              <div
                class="flex justify-between items-center p-4 border-b"
                style="border-color: var(--color-border-primary);"
              >
                <h2 class="text-lg font-semibold" style="color: var(--color-text-primary);">
                  Video Settings
                </h2>
                <Show when={!hasAnyChanges()} fallback={<div class="w-6 h-6" />}>
                  <button
                    type="button"
                    onClick={() => setShowPopup(false)}
                    class="text-gray-500 hover:text-gray-700 transition-colors"
                    style="color: var(--color-text-secondary);"
                  >
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </Show>
              </div>

              <div class="p-6">
                <Show
                  when={Array.isArray(props.dataSourcesOptions) && props.dataSourcesOptions.length > 0}
                >
                  <div class="mb-6">
                    <div class="flex items-center justify-between mb-3">
                      <h3 class="text-base font-semibold" style="color: var(--color-text-primary);">
                        Data Sources
                      </h3>
                      <div class="flex gap-2">
                        <button
                          type="button"
                          class="px-2 py-1 text-xs rounded-md"
                          style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                          onClick={() => {
                            const allIds = new Set<number>(
                              (props.dataSourcesOptions ?? [])
                                .map((opt) => {
                                  const m = opt.key?.match(/source-(\d+)/);
                                  return m ? Number(m[1]) : null;
                                })
                                .filter((id): id is number => id !== null)
                            );
                            setLocalSourceSelections(allIds);
                          }}
                        >
                          Select All
                        </button>
                        <button
                          type="button"
                          class="px-2 py-1 text-xs rounded-md"
                          style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                          onClick={() => setLocalSourceSelections(new Set<number>())}
                        >
                          None
                        </button>
                      </div>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      {(() => {
                        const options = props.dataSourcesOptions ?? [];
                        const sorted = [...options].sort((a, b) => {
                          const aId = a.key?.match(/source-(\d+)/)?.[1] ?? "0";
                          const bId = b.key?.match(/source-(\d+)/)?.[1] ?? "0";
                          return Number(aId) - Number(bId);
                        });
                        return sorted.map((option) => {
                          const sourceName = option.label || option.name || "";
                          const sourceColor = sourcesStore.getSourceColor(sourceName);
                          const getIsSelected = () => {
                            const m = option.key?.match(/source-(\d+)/);
                            if (m) return localSourceSelections().has(Number(m[1]));
                            return false;
                          };
                          return (
                            <span
                              class={`px-3 py-1 rounded-full text-sm cursor-pointer font-medium transition-colors ${
                                getIsSelected()
                                  ? "bg-blue-600 text-white"
                                  : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                              }`}
                              style={
                                getIsSelected() && sourceColor
                                  ? `background-color: ${sourceColor}; color: white;`
                                  : ""
                              }
                              onClick={() => handleDisplayOptionClick(option)}
                            >
                              {option.label}
                            </span>
                          );
                        });
                      })()}
                    </div>
                  </div>
                </Show>

                <Show when={(props.filterConfig?.showRaces && raceOptionsFiltered().length > 0) || (props.filterConfig?.showLegs && visibleLegOptions().length > 0)}>
                  <div class="mt-6 pt-4 border-t" style="border-color: var(--color-border-primary);">
                    <div class="flex items-center justify-between mb-3">
                      <h3 class="text-base font-semibold" style="color: var(--color-text-primary);">
                        Race &amp; Leg
                      </h3>
                      <button
                        type="button"
                        class="px-2 py-1 text-xs rounded-md"
                        style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                        onClick={handleClearRaceLeg}
                      >
                        Clear
                      </button>
                    </div>
                    <Show when={props.filterConfig?.showRaces && raceOptionsFiltered().length > 0}>
                      <div class="mb-3">
                        <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">Race</div>
                        <div class="flex flex-wrap gap-2">
                          {raceOptionsFiltered().map((option) => {
                            const isSelected = Array.from(localRaceSelections()).some((val) => isSameRace(val, option));
                            return (
                              <span
                                class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                                  isSelected ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                                }`}
                                onClick={() => handleRaceClick(option)}
                                onContextMenu={(e) => e.preventDefault()}
                              >
                                {formatRaceForDisplay(option)}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </Show>
                    <Show when={props.filterConfig?.showLegs && visibleLegOptions().length > 0}>
                      <div>
                        <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">Leg</div>
                        <div class="flex flex-wrap gap-2">
                          {visibleLegOptions().map((option) => {
                            const isSelected = localLegSelections().has(option);
                            return (
                              <span
                                class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                                  isSelected ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                                }`}
                                onClick={() => handleLegClick(option)}
                                onContextMenu={(e) => e.preventDefault()}
                              >
                                {option}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>

              <div
                class="flex justify-between items-center p-4 border-t"
                style="border-color: var(--color-border-primary);"
              >
                <div class="flex gap-2" />
                <div class="flex gap-2">
                  <Show when={isAdminOrPublisher()}>
                    <button
                      type="button"
                      onClick={() => handleSaveAsDefault()}
                      class="px-4 py-2 text-sm rounded-md transition-colors"
                      style={
                        saveDefaultSuccessFlash()
                          ? "background: #10b981; color: white; transition: background-color 0.2s ease, color 0.2s ease;"
                          : "background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                      }
                      onMouseEnter={(e) => {
                        if (saveDefaultSuccessFlash()) return;
                        const btn = e.currentTarget;
                        if (btn) btn.style.backgroundColor = "var(--color-bg-button-secondary-hover)";
                      }}
                      onMouseLeave={(e) => {
                        const btn = e.currentTarget;
                        if (btn)
                          btn.style.backgroundColor = saveDefaultSuccessFlash()
                            ? "#10b981"
                            : "var(--color-bg-button-secondary)";
                      }}
                    >
                      {saveDefaultSuccessFlash() ? "Saved!" : "Save as default"}
                    </button>
                  </Show>
                  <Show
                    when={hasAnyChanges()}
                    fallback={
                      <button
                        type="button"
                        onClick={() => setShowPopup(false)}
                        class="px-4 py-2 text-sm rounded-md transition-colors"
                        style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                      >
                        Close
                      </button>
                    }
                  >
                    <button
                      type="button"
                      onClick={async () => {
                        await handleApplyChanges();
                        setShowPopup(false);
                      }}
                      class="px-4 py-2 text-sm rounded-md transition-colors font-medium"
                      style="background: #10b981; color: white;"
                    >
                      Apply
                    </button>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}
