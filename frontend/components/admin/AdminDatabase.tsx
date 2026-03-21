import { createMemo, Show, createSignal } from "solid-js";
import { user } from "../../store/userStore";
import { postData, getData } from "../../utils/global";
import { apiEndpoints } from "@config/env";
import { error as logError, info, debug, warn } from "../../utils/console";
import { persistantStore } from "../../store/persistantStore";

export default function AdminDatabase() {
  // Check if user is super user
  const isSuperUser = createMemo(() => {
    const currentUser = user();
    return currentUser?.is_super_user === true;
  });

  const [populating, setPopulating] = createSignal(false);
  const [populateResult, setPopulateResult] = createSignal<string | null>(null);
  const [populateError, setPopulateError] = createSignal<string | null>(null);

  const handlePopulateChannels = async () => {
    const className = 'gp50';
    const projectId = persistantStore.selectedProjectId?.() || 1; // Default to project 1 if not set
    const testDate = '2026-01-17';
    const hardcodedSourceName = 'GER';
    
    try {
      setPopulating(true);
      setPopulateResult(null);
      setPopulateError(null);
      
      info(`[AdminDatabase] Starting channel population for date ${testDate}, source: ${hardcodedSourceName}`);
      
      // Fetch sources to find source_id for GER
      const sourcesResponse = await getData(
        `${apiEndpoints.app.sources}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}`
      );
      
      if (!sourcesResponse.success || !Array.isArray(sourcesResponse.data)) {
        throw new Error('Failed to fetch sources. Please ensure you have sources configured.');
      }
      
      // Find GER source
      const gerSource = sourcesResponse.data.find((s: any) => 
        s.source_name && s.source_name.toUpperCase() === hardcodedSourceName.toUpperCase()
      );
      
      if (!gerSource) {
        throw new Error(`Source "${hardcodedSourceName}" not found for this project. Available sources: ${sourcesResponse.data.map((s: any) => s.source_name).join(', ')}`);
      }
      
      const sourceId = gerSource.source_id;
      info(`[AdminDatabase] Found source_id ${sourceId} for source "${hardcodedSourceName}"`);
      
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
              source_id: sourceId
            }
          ]
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
        <div
          class="filter-controls mt-2"
          style={{
            "background-color": "var(--color-bg-secondary)",
            "transition": "background-color 0.3s ease",
            "width": "98%",
          }}
        >
          <label class="block text-sm font-medium text-gray-700 mb-1">Options</label>
          <div class="space-y-3">
            <Show when={isSuperUser()}>
              <div class="space-y-4">
                <div class="border-b border-gray-200 pb-3">
                  <h3 class="text-sm font-semibold text-gray-800 mb-2">Channel Population</h3>
                  <p class="text-sm text-gray-600 mb-3">
                    Populate channels table for testing. This will populate channels for date 2026-01-17 using source GER.
                  </p>
                  <button
                    onClick={handlePopulateChannels}
                    disabled={populating()}
                    class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                  >
                    {populating() ? 'Populating Channels...' : 'Populate Channels (2026-01-17)'}
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
