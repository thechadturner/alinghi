import { createMemo, Show, createSignal, createEffect, For } from "solid-js";
import { user } from "../../store/userStore";
import { postData, getData } from "../../utils/global";
import { apiEndpoints } from "@config/env";
import { error as logError, info, warn } from "../../utils/console";
import { persistantStore } from "../../store/persistantStore";

/** Default source when present in the project (legacy test button assumed GER). */
const DEFAULT_PREFERRED_SOURCE = "GER";

interface SourceRow {
  source_id: number;
  source_name: string;
}

export default function AdminDatabase() {
  // Check if user is super user
  const isSuperUser = createMemo(() => {
    const currentUser = user();
    return currentUser?.is_super_user === true;
  });

  const [populating, setPopulating] = createSignal(false);
  const [populateResult, setPopulateResult] = createSignal<string | null>(null);
  const [populateError, setPopulateError] = createSignal<string | null>(null);
  const [sources, setSources] = createSignal<SourceRow[]>([]);
  const [sourcesLoading, setSourcesLoading] = createSignal(false);
  const [populateSourceId, setPopulateSourceId] = createSignal<number | null>(null);
  const [populateDate, setPopulateDate] = createSignal("2026-01-17");

  let sourcesFetchSeq = 0;
  createEffect(() => {
    const projectId = persistantStore.selectedProjectId?.() ?? 0;
    const className = (persistantStore.selectedClassName?.() || "ac40").trim() || "ac40";

    if (!projectId) {
      sourcesFetchSeq += 1;
      setSources([]);
      setPopulateSourceId(null);
      setSourcesLoading(false);
      return;
    }

    const seq = ++sourcesFetchSeq;
    setSourcesLoading(true);
    void (async () => {
      try {
        const sourcesResponse = await getData(
          `${apiEndpoints.app.sources}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}`
        );
        if (seq !== sourcesFetchSeq) return;

        if (!sourcesResponse.success || !Array.isArray(sourcesResponse.data)) {
          setSources([]);
          setPopulateSourceId(null);
          warn("[AdminDatabase] Failed to load sources for channel population");
          return;
        }

        const list = sourcesResponse.data as SourceRow[];
        setSources(list);
        setPopulateSourceId((prev) => {
          if (prev != null && list.some((s) => s.source_id === prev)) return prev;
          const preferred = list.find(
            (s) => s.source_name && s.source_name.toUpperCase() === DEFAULT_PREFERRED_SOURCE
          );
          return preferred?.source_id ?? list[0]?.source_id ?? null;
        });
      } catch (e) {
        if (seq !== sourcesFetchSeq) return;
        logError("[AdminDatabase] Error loading sources:", e);
        setSources([]);
        setPopulateSourceId(null);
      } finally {
        if (seq === sourcesFetchSeq) setSourcesLoading(false);
      }
    })();
  });

  const handlePopulateChannels = async () => {
    const className = (persistantStore.selectedClassName?.() || "ac40").trim() || "ac40";
    const projectId = persistantStore.selectedProjectId?.() ?? 0;
    const testDate = populateDate();
    const sourceId = populateSourceId();

    try {
      setPopulating(true);
      setPopulateResult(null);
      setPopulateError(null);

      if (!projectId) {
        throw new Error("Select a project in the app header first.");
      }
      if (sourceId == null) {
        throw new Error(
          "No data source selected. Wait for sources to load or configure sources for this project."
        );
      }

      const sourceName =
        sources().find((s) => s.source_id === sourceId)?.source_name ?? `source_id ${sourceId}`;
      info(
        `[AdminDatabase] Starting channel population for date ${testDate}, source: ${sourceName} (id ${sourceId})`
      );
      
      // Call populate channels endpoint with force_refresh to bypass existence check
      const populateResponse = await postData(
        `${apiEndpoints.app.datasets}/channels/populate`,
        {
          class_name: className,
          project_id: projectId,
          force_refresh: true, // Force refresh to test new InfluxDB query logic
          dates: [
            {
              date: testDate,
              source_id: sourceId,
            },
          ],
        }
      );
      
      if (populateResponse.success) {
        const result = populateResponse.data as { processed?: number; error_count?: number; errors?: unknown[] };
        const errCount = result.error_count ?? (Array.isArray(result.errors) ? result.errors.length : 0);
        const message = `Channel population completed: ${result.processed ?? 0} date(s) processed, ${errCount} error(s)`;
        setPopulateResult(message);
        info(`[AdminDatabase] ${message}`, result);
      } else {
        const errorMsg = populateResponse.message || 'Unknown error';
        setPopulateError(errorMsg);
        logError(`[AdminDatabase] Channel population failed:`, errorMsg);
      }
    } catch (error: any) {
      const errorMsg = error.message || 'Unknown error';
      setPopulateError(errorMsg);
      logError(`[AdminDatabase] Error populating channels:`, error);
    } finally {
      setPopulating(false);
    }
  };

  return (
    <div class="admin-database">
      <div class="admin-page-header">
        <h1>Database Administration</h1>
        <p>Database maintenance and destructive operations (Super User only)</p>
      </div>

      <div class="space-y-6">
        {/* Options - styled like Script Execution Project area */}
        <div class="filter-controls admin-database-options mt-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">Options</label>
          <div class="space-y-3">
            <Show when={isSuperUser()}>
              <div class="space-y-4">
                <div class="border-b border-gray-200 pb-3">
                  <h3 class="text-sm font-semibold text-gray-800 mb-2">Channel Population</h3>
                  <p class="text-sm text-gray-600 mb-3">
                    Populate the channels table for testing. Uses the current class and project from the app header.
                    Defaults to source {DEFAULT_PREFERRED_SOURCE} when that source exists; otherwise choose a source
                    below.
                  </p>
                  <div class="flex flex-wrap gap-4 items-end mb-3">
                    <div class="min-w-[200px]">
                      <label class="block text-xs font-medium text-gray-600 mb-1" for="admin-populate-source">
                        Data source
                      </label>
                      <select
                        id="admin-populate-source"
                        class="w-full"
                        value={populateSourceId() ?? ""}
                        onChange={(e) => {
                          const v = e.currentTarget.value;
                          setPopulateSourceId(v ? Number(v) : null);
                        }}
                        disabled={sourcesLoading() || sources().length === 0 || populating()}
                      >
                        <Show
                          when={sources().length > 0}
                          fallback={<option value="">No sources loaded</option>}
                        >
                          <For each={sources()}>
                            {(s) => <option value={String(s.source_id)}>{s.source_name}</option>}
                          </For>
                        </Show>
                      </select>
                      <Show when={sourcesLoading()}>
                        <p class="text-xs text-gray-500 mt-1">Loading sources…</p>
                      </Show>
                    </div>
                    <div class="min-w-[160px]">
                      <label class="block text-xs font-medium text-gray-600 mb-1" for="admin-populate-date">
                        Date
                      </label>
                      <input
                        id="admin-populate-date"
                        type="date"
                        class="w-full"
                        value={populateDate()}
                        onInput={(e) => setPopulateDate(e.currentTarget.value)}
                        disabled={populating()}
                      />
                    </div>
                  </div>
                  <button
                    onClick={handlePopulateChannels}
                    disabled={populating() || sourcesLoading() || populateSourceId() == null}
                    class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                  >
                    {populating() ? "Populating Channels..." : "Populate Channels"}
                  </button>
                  
                  <Show when={populateResult()}>
                    <div class="mt-3 p-3 bg-green-50 border border-green-200 rounded text-sm text-green-800">
                      {populateResult()}
                    </div>
                  </Show>
                  
                  <Show when={populateError()}>
                    <div class="mt-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
                      Error: {populateError()}
                    </div>
                  </Show>
                </div>
                
                <p class="text-sm text-gray-500 italic">
                  Additional database administration options will be available here.
                </p>
              </div>
            </Show>
            <Show when={!isSuperUser()}>
              <p class="text-sm text-gray-500 italic">
                Super User access required. Database administration options are only visible to super users.
              </p>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
