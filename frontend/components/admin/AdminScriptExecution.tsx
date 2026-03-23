import { createSignal, onMount, onCleanup, Show, For, createMemo, createEffect } from "solid-js";
import { getData, postData, putData, getTimezoneForDate } from "../../utils/global";
import { apiEndpoints } from "@config/env";
import { error as logError, info, debug, warn } from "../../utils/console";
import { sseManager } from "../../store/sseManager";
import { processStore } from "../../store/processStore";

interface Project {
  project_id: number;
  project_name?: string;
  description?: string; // Format: "class_name - project_name"
  class_name?: string;
}

interface Source {
  source_id: number;
  source_name: string;
}

interface Dataset {
  dataset_id: number;
  date: string;
  source_id: number;
  source_name?: string;
  event_name?: string;
  timezone?: string;
}

interface ExecutionStatus {
  dataset_id: number;
  date: string;
  source_name: string;
  script_name: string;
  status: "pending" | "running" | "success" | "error" | "retry" | "canceled";
  error?: string;
  process_id?: string;
  started_at?: string; // Timestamp when process started
  recovered?: boolean; // Flag to indicate this was recovered from previous session
}

const STORAGE_KEY = 'admin_script_execution_statuses';

// Persist execution statuses to localStorage
const saveExecutionStatuses = (statuses: ExecutionStatus[]) => {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));
      debug(`[AdminScriptExecution] Saved ${statuses.length} execution status(es) to localStorage`);
    }
  } catch (error) {
    warn(`[AdminScriptExecution] Failed to save execution statuses:`, error);
  }
};

// Load execution statuses from localStorage
const loadExecutionStatuses = (): ExecutionStatus[] => {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const statuses = JSON.parse(stored) as ExecutionStatus[];
        debug(`[AdminScriptExecution] Loaded ${statuses.length} execution status(es) from localStorage`);
        return statuses;
      }
    }
  } catch (error) {
    warn(`[AdminScriptExecution] Failed to load execution statuses:`, error);
  }
  return [];
};

// Clear persisted execution statuses
const clearExecutionStatuses = () => {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
      debug(`[AdminScriptExecution] Cleared execution statuses from localStorage`);
    }
  } catch (error) {
    warn(`[AdminScriptExecution] Failed to clear execution statuses:`, error);
  }
};

export default function AdminScriptExecution() {
  const [projects, setProjects] = createSignal<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = createSignal<number | null>(null);
  const [selectedClassName, setSelectedClassName] = createSignal<string>("");
  const [sources, setSources] = createSignal<Source[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = createSignal<Set<number>>(new Set());
  const [startDate, setStartDate] = createSignal<string>("");
  const [endDate, setEndDate] = createSignal<string>("");
  const [datasets, setDatasets] = createSignal<Dataset[]>([]);
  const [executionStatuses, setExecutionStatuses] = createSignal<ExecutionStatus[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [executing, setExecuting] = createSignal(false);
  const [includeInvisible, setIncludeInvisible] = createSignal(false);
  const [cancellingAll, setCancellingAll] = createSignal(false);
  const [runningProcessesFromAPI, setRunningProcessesFromAPI] = createSignal<any[]>([]);
  const [updatingChannels, setUpdatingChannels] = createSignal(false);
  const [channelUpdateMessage, setChannelUpdateMessage] = createSignal<string | null>(null);
  const [updatingCleanup, setUpdatingCleanup] = createSignal(false);
  const [cleanupPagesOnly, setCleanupPagesOnly] = createSignal(false);
  const [cleanupMessage, setCleanupMessage] = createSignal<string | null>(null);
  const [updatingMarkwind, setUpdatingMarkwind] = createSignal(false);
  const [markwindMessage, setMarkwindMessage] = createSignal<string | null>(null);

  // Fetch all projects
  const fetchProjects = async () => {
    const controller = new AbortController();
    
    try {
      const response = await getData(`${apiEndpoints.app.projects}/type?type=user`, controller.signal);
      
      if (response.success) {
        const projectsData = response.data || [];
        // The API returns description in format "class_name - project_name"
        // We can use description directly or parse it
        setProjects(projectsData);
        info(`Loaded ${projectsData.length} project(s)`);
      } else {
        logError("Failed to fetch projects:", response.message || "Unknown error");
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        logError("Error fetching projects:", error);
      }
    }
  };

  // Fetch project details to get class_name
  const fetchProjectData = async (projectId: number) => {
    const controller = new AbortController();
    
    try {
      const response = await getData(`${apiEndpoints.app.projects}/id?project_id=${projectId}`, controller.signal);
      
      if (response.success && response.data) {
        setSelectedClassName(response.data.class_name?.toLowerCase() || "");
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        logError("Error fetching project data:", error);
      }
    }
  };

  // Fetch sources for selected project
  const fetchSources = async () => {
    if (!selectedProjectId() || !selectedClassName()) return;
    
    const controller = new AbortController();
    
    try {
      const response = await getData(
        `${apiEndpoints.app.sources}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId()!)}`,
        controller.signal
      );
      
      if (response.success) {
        setSources(response.data || []);
        setSelectedSourceIds(new Set<number>()); // Clear selection when sources change
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        logError("Error fetching sources:", error);
      }
    }
  };

  // Handle project selection
  const handleProjectChange = async (projectId: number) => {
    setSelectedProjectId(projectId);
    setSelectedSourceIds(new Set<number>());
    setDatasets([]);
    setExecutionStatuses([]);
    
    if (projectId) {
      await fetchProjectData(projectId);
    }
  };

  // Handle source checkbox toggle
  const toggleSource = (sourceId: number) => {
    const newSet = new Set(selectedSourceIds());
    if (newSet.has(sourceId)) {
      newSet.delete(sourceId);
    } else {
      newSet.add(sourceId);
    }
    setSelectedSourceIds(newSet);
  };

  // Toggle all sources
  const toggleAllSources = () => {
    const currentSelected = selectedSourceIds();
    const allSourceIds = sources().map(s => s.source_id);
    const allSelected = allSourceIds.length > 0 && allSourceIds.every(id => currentSelected.has(id));
    
    if (allSelected) {
      // Deselect all
      setSelectedSourceIds(new Set<number>());
    } else {
      // Select all
      setSelectedSourceIds(new Set<number>(allSourceIds));
    }
  };

  // Check if all sources are selected
  const areAllSourcesSelected = () => {
    const currentSelected = selectedSourceIds();
    const allSourceIds = sources().map(s => s.source_id);
    return allSourceIds.length > 0 && allSourceIds.every(id => currentSelected.has(id));
  };

  // Cancel a running process
  const cancelRunningProcess = async (processId: string): Promise<boolean> => {
    try {
      const id = String(processId);
      const response = await postData(apiEndpoints.python.cancel_process(id), {});
      if (response?.success) {
        info(`[AdminScriptExecution] Successfully cancelled process ${processId}`);
        return true;
      } else {
        warn(`[AdminScriptExecution] Failed to cancel process ${processId}: ${response?.message || 'Unknown error'}`);
        return false;
      }
    } catch (error: any) {
      warn(`[AdminScriptExecution] Error cancelling process ${processId}:`, error);
      return false;
    }
  };

  // Cancel all running/queued processes
  const cancelAllProcesses = async () => {
    if (!confirm('Are you sure you want to cancel ALL running and queued scripts? This action cannot be undone.')) {
      return;
    }

    setCancellingAll(true);
    try {
      // Collect process IDs from API and from local state (so we cancel even if API is empty or out of sync)
      const processIdsToCancel = new Set<string>();
      const response = await getData(apiEndpoints.python.running_processes);
      if (response.success && response.data) {
        const processes = response.data.processes || [];
        for (const proc of processes) {
          if (proc?.process_id != null) processIdsToCancel.add(String(proc.process_id));
        }
      } else {
        warn('[AdminScriptExecution] Failed to fetch running processes; will still try local process IDs');
      }
      const statuses = executionStatuses();
      for (const s of statuses) {
        if ((s.status === "running" || s.status === "pending") && s.process_id) {
          processIdsToCancel.add(String(s.process_id));
        }
      }
      const ids = Array.from(processIdsToCancel);
      if (ids.length === 0) {
        info('[AdminScriptExecution] No running processes to cancel');
        setCancellingAll(false);
        return;
      }
      info(`[AdminScriptExecution] Cancelling ${ids.length} process(es)...`);
      const cancelPromises = ids.map((id) => cancelRunningProcess(id));
      const results = await Promise.allSettled(cancelPromises);
      const successCount = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
      const failCount = results.length - successCount;
      if (successCount > 0) {
        info(`[AdminScriptExecution] Successfully cancelled ${successCount} process(es)`);
      }
      if (failCount > 0) {
        warn(`[AdminScriptExecution] Failed to cancel ${failCount} process(es)`);
      }
      // Always mark all pending/running in local state as canceled so UI reflects user intent
      setExecutionStatuses((prev) =>
        prev.map((status) => {
          if (status.status === "pending" || status.status === "running") {
            return { ...status, status: "canceled" as const, error: "Canceled" };
          }
          return status;
        })
      );
    } catch (error: any) {
      logError('[AdminScriptExecution] Error cancelling all processes:', error);
      // Still mark local running/pending as canceled so UI is consistent
      setExecutionStatuses((prev) =>
        prev.map((status) => {
          if (status.status === "pending" || status.status === "running") {
            return { ...status, status: "canceled" as const, error: "Canceled" };
          }
          return status;
        })
      );
    } finally {
      setCancellingAll(false);
    }
  };

  // Fetch datasets for selected sources
  const fetchDatasets = async () => {
    if (!selectedProjectId() || !selectedClassName() || selectedSourceIds().size === 0 || !startDate() || !endDate()) {
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    
    try {
      const allDatasets: Dataset[] = [];
      const start = new Date(startDate());
      const end = new Date(endDate());
      
      // Fetch datasets for each selected source
      for (const sourceId of selectedSourceIds()) {
        try {
          const response = await getData(
            `${apiEndpoints.app.datasets}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId()!)}&source_id=${encodeURIComponent(sourceId)}&year_name=ALL&event_name=ALL`,
            controller.signal
          );
          
          if (response.success && response.data) {
            // Filter datasets by date range and add source info
            const source = sources().find(s => s.source_id === sourceId);
            const filtered = response.data
              .filter((ds: any) => {
                const dsDate = new Date(ds.date);
                const inDateRange = dsDate >= start && dsDate <= end;
                
                // If includeInvisible is true, ONLY include invisible datasets (visible = 0 or false)
                // If includeInvisible is false, include all datasets that match the date range
                const visibleFilter = includeInvisible() 
                  ? (ds.visible === 0 || ds.visible === false)  // ONLY invisible when checked
                  : true;  // All datasets when unchecked
                
                return inDateRange && visibleFilter;
              })
              .map((ds: any) => ({
                ...ds,
                source_id: sourceId,
                source_name: source?.source_name || ""
              }));
            
            allDatasets.push(...filtered);
          }
        } catch (error: any) {
          if (error.name !== 'AbortError') {
            logError(`Error fetching datasets for source ${sourceId}:`, error);
          }
        }
      }
      
      setDatasets(allDatasets);
      info(`Found ${allDatasets.length} datasets in date range`);
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        logError("Error fetching datasets:", error);
      }
    } finally {
      setLoading(false);
    }
  };

  // Execute script for all datasets
  const executeScript = async (scriptName: string) => {
    if (datasets().length === 0) {
      logError("No datasets to process. Please fetch datasets first.");
      return;
    }

    setExecuting(true);
    
    // Store datasets array at start to avoid reactivity issues during loop
    const datasetsToProcess = datasets();
    const totalDatasets = datasetsToProcess.length;
    
    info(`[AdminScriptExecution] Starting execution of ${scriptName} for ${totalDatasets} dataset(s)`);
    
    // Initialize statuses for all datasets
    const initialStatuses: ExecutionStatus[] = datasetsToProcess.map(ds => ({
      dataset_id: ds.dataset_id,
      date: ds.date,
      source_name: ds.source_name || "",
      script_name: scriptName,
      status: "pending" as const,
      started_at: new Date().toISOString()
    }));
    setExecutionStatuses(initialStatuses);

    // Pre-establish SSE connection and verify it's working
    const sseConnected = await sseManager.connectToServer(8049);
    if (!sseConnected) {
      warn('[AdminScriptExecution] Failed to establish SSE connection, will use polling fallback');
    } else {
      debug('[AdminScriptExecution] SSE connection established successfully');
    }

    // Execute script for each dataset sequentially
    for (let i = 0; i < totalDatasets; i++) {
      const dataset = datasetsToProcess[i];
      
      info(`[AdminScriptExecution] Processing dataset ${i + 1}/${totalDatasets}: ${dataset.dataset_id} (${dataset.date}, ${dataset.source_name})`);
      
      // Update status to running
      setExecutionStatuses(prev => prev.map(status => 
        status.dataset_id === dataset.dataset_id && status.script_name === scriptName
          ? { ...status, status: "running" as const }
          : status
      ));

      try {
        const sanitizedDate = dataset.date.replace(/[-/]/g, "");

        // Source name must match the folder under the file server (System/.../date/<source>/). Prefer name from
        // the fetched dataset row, then project sources list — empty string causes channel-groups 404 / script failure.
        const sourceFromStore = sources().find((s) => s.source_id === dataset.source_id);
        const sourceName = (
          (dataset.source_name && String(dataset.source_name).trim()) ||
          (sourceFromStore?.source_name && String(sourceFromStore.source_name).trim()) ||
          ""
        );

        if (!sourceName) {
          const msg = `Missing source_name for dataset_id=${dataset.dataset_id} (source_id=${dataset.source_id}). Scripts need the boat folder name on the file server.`;
          logError(`[AdminScriptExecution] ${msg}`);
          setExecutionStatuses((prev) =>
            prev.map((status) =>
              status.dataset_id === dataset.dataset_id && status.script_name === scriptName
                ? { ...status, status: "error" as const, error: msg }
                : status
            )
          );
          continue;
        }

        // Build parameters to match the flow that works for each script.
        // For 1_normalization_influx.py: match UploadDatasets.tsx (upload datasets page) exactly (no start_time/end_time; backend uses full-day from date + timezone).
        // For other scripts (e.g. 3_execute.py): include start_time/end_time (null) and batch so script can derive range from data if needed.
        const isNormalizeInflux = scriptName === '1_normalization_influx.py';
        const parameters: Record<string, string | number | boolean | null> = isNormalizeInflux
          ? {
              project_id: selectedProjectId()!,
              class_name: selectedClassName(),
              date: sanitizedDate,
              source_name: sourceName,
              timezone: dataset.timezone ?? 'Europe/Madrid'
            }
          : {
              project_id: selectedProjectId()!.toString(),
              class_name: selectedClassName(),
              dataset_id: dataset.dataset_id.toString(),
              date: sanitizedDate,
              source_name: sourceName,
              start_time: null as string | null,
              end_time: null as string | null,
              timezone: dataset.timezone ?? 'Europe/Madrid',
              batch: true,
              verbose: false
            };

        const payload = {
          project_id: selectedProjectId()!.toString(),
          class_name: selectedClassName(),
          script_name: scriptName,
          parameters: parameters,
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, 300000); // 5 minute timeout (allows time for server to start process and return process_id)

        info(`[AdminScriptExecution] Sending execution request for dataset ${dataset.dataset_id} (${i + 1}/${totalDatasets})`);
        debug(`[AdminScriptExecution] Execution payload:`, payload);
        
        let response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
        clearTimeout(timeoutId);

        debug(`[AdminScriptExecution] Execution response for dataset ${dataset.dataset_id}:`, response_json);

        // Check for request cancellation (timeout or abort)
        if (response_json?.type === 'AbortError' || response_json?.message === 'Request cancelled') {
          throw new Error(`Request timeout for ${scriptName} on dataset ${dataset.dataset_id} - script may still be running`);
        }

        // Check if server returned "process already running" status
        // For AdminScriptExecution, we wait for the process to complete instead of canceling
        // This allows concurrent execution without interruption
        if (response_json?.data?.process_already_running) {
          const runningProcesses = response_json.data.running_processes || [];
          const processList = runningProcesses.map((p: any) => 
            `- ${p.script_name} (${p.class_name}) - Started: ${p.started_at || 'unknown'}`
          ).join('\n');
          
          info(`[AdminScriptExecution] Process already running for dataset ${dataset.dataset_id}. Waiting for completion...\n${processList}`);
          
          // Update status to show we're waiting
          const runningProcessNames = runningProcesses.map((p: any) => p.script_name).join(', ');
          setExecutionStatuses(prev => prev.map(status => 
            status.dataset_id === dataset.dataset_id && status.script_name === scriptName
              ? { ...status, status: "pending" as const, error: `Waiting for running process to complete (${runningProcessNames})...` }
              : status
          ));
          
          // Wait for running processes to complete by polling the running processes endpoint
          const maxWaitTime = 3600000; // 1 hour max wait
          const pollInterval = 5000; // Check every 5 seconds
          const startWaitTime = Date.now();
          let allProcessesCompleted = false;
          
          while (!allProcessesCompleted && (Date.now() - startWaitTime) < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            
            try {
              const runningCheck = await getData(apiEndpoints.python.running_processes);
              if (runningCheck?.success && runningCheck?.data) {
                const stillRunning = runningCheck.data.processes || [];
                const stillRunningIds = new Set(stillRunning.map((p: any) => p.process_id));
                
                // Check if any of the processes we're waiting for are still running
                const waitingForProcesses = runningProcesses.map((p: any) => p.process_id);
                allProcessesCompleted = !waitingForProcesses.some((pid: string) => stillRunningIds.has(pid));
                
                if (!allProcessesCompleted) {
                  const elapsed = Math.round((Date.now() - startWaitTime) / 1000);
                  debug(`[AdminScriptExecution] Still waiting for processes to complete... (${elapsed}s elapsed)`);
                }
              } else {
                // If we can't check, assume processes completed
                allProcessesCompleted = true;
              }
            } catch (error) {
              warn('[AdminScriptExecution] Error checking running processes:', error);
              // Continue waiting
            }
          }
          
          if (!allProcessesCompleted) {
            throw new Error(`Timeout waiting for running processes to complete for dataset ${dataset.dataset_id}`);
          }
          
          info(`[AdminScriptExecution] Running processes completed, retrying dataset ${dataset.dataset_id}...`);
          
          // Create a new AbortController for the retry request (the original one may be aborted)
          const retryController = new AbortController();
          const retryTimeoutId = setTimeout(() => {
            retryController.abort();
          }, 300000); // 5 minute timeout for retry
          
          // Retry the script execution after processes completed
          const retryResponse = await postData(apiEndpoints.python.execute_script, payload, retryController.signal);
          clearTimeout(retryTimeoutId);
          
          // Check for request cancellation on retry
          if (retryResponse?.type === 'AbortError' || retryResponse?.message === 'Request cancelled') {
            throw new Error(`Request timeout for ${scriptName} on dataset ${dataset.dataset_id} (retry) - script may still be running`);
          }
          
          if (!retryResponse?.success) {
            // Check if there's still a process running (race condition)
            if (retryResponse?.data?.process_already_running) {
              throw new Error(`Process still running after wait for dataset ${dataset.dataset_id} - may need manual intervention`);
            } else {
              throw new Error(retryResponse?.message || 'Script execution failed after retry');
            }
          }
          // Use the retry response as the new response_json
          response_json = retryResponse;
        }

        if (!response_json?.success) {
          throw new Error(response_json?.message || 'Script execution failed');
        }

        const pid = (response_json as any).process_id || (response_json as any)?.data?.process_id;
        
        if (!pid) {
          throw new Error('No process_id returned');
        }
        
        info(`[AdminScriptExecution] Received process_id ${pid} for dataset ${dataset.dataset_id} (${i + 1}/${totalDatasets})`);

        // Update status with process_id
        setExecutionStatuses(prev => prev.map(status => 
          status.dataset_id === dataset.dataset_id && status.script_name === scriptName
            ? { ...status, process_id: pid, status: "running" as const }
            : status
        ));

        // Start process tracking
        // For 3_execute.py, use showToast: false since we're tracking in the status table
        // For individual scripts, also use false to avoid duplicate toasts
        processStore.startProcess(pid, 'script_execution', false);

        // Wait for completion
        debug(`[AdminScriptExecution] Waiting for process ${pid} to complete for dataset ${dataset.dataset_id}`);
        try {
          await waitForProcessCompletion(pid, dataset.dataset_id, scriptName);
          debug(`[AdminScriptExecution] Process ${pid} completed for dataset ${dataset.dataset_id}, moving to next dataset`);
          
          // Small delay between scripts to ensure clean state and allow SSE messages to propagate
          if (i < totalDatasets - 1) {
            info(`[AdminScriptExecution] Completed dataset ${i + 1}/${totalDatasets}, waiting 2s before next dataset...`);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Increased to 2s to allow cleanup
            
            // Verify SSE connection is still active before starting next process
            const sseStillConnected = sseManager.isConnected(8049);
            if (!sseStillConnected) {
              warn(`[AdminScriptExecution] SSE connection lost, reconnecting before dataset ${i + 2}...`);
              const reconnectResult = await sseManager.connectToServer(8049);
              debug(`[AdminScriptExecution] SSE reconnection result: ${reconnectResult}`);
            } else {
              debug(`[AdminScriptExecution] SSE connection verified active before dataset ${i + 2}`);
            }
          } else {
            info(`[AdminScriptExecution] Completed final dataset ${i + 1}/${totalDatasets}`);
          }
        } catch (waitError: any) {
          // If waitForProcessCompletion throws an error, log it but continue
          warn(`[AdminScriptExecution] Error waiting for process ${pid} completion:`, waitError);
          // Update status to indicate we couldn't determine completion
          setExecutionStatuses(prev => prev.map(status => 
            status.dataset_id === dataset.dataset_id && status.script_name === scriptName
              ? { ...status, status: "error" as const, error: `Wait error: ${waitError.message || 'Unknown'}` }
              : status
          ));
          // Continue to next dataset with delay
          if (i < totalDatasets - 1) {
            info(`[AdminScriptExecution] Error on dataset ${i + 1}/${totalDatasets}, waiting 2s before next dataset...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

      } catch (error: any) {
        // Handle AbortError (timeout) and request cancellation differently from other errors
        const isTimeout = error.name === 'AbortError' || 
                         error.message?.includes('timeout') || 
                         error.message?.includes('Request timeout');
        
        if (isTimeout) {
          warn(`Request timeout for ${scriptName} on dataset ${dataset.dataset_id} (${i + 1}/${totalDatasets}) - script may still be running`);
          setExecutionStatuses(prev => prev.map(status => 
            status.dataset_id === dataset.dataset_id && status.script_name === scriptName
              ? { ...status, status: "error" as const, error: "Request timeout - script may still be running" }
              : status
          ));
          
          // Immediately check if the process is actually running (request might have timed out but process started)
          await syncStatusesWithRunningProcesses();
        } else {
          logError(`Error executing ${scriptName} for dataset ${dataset.dataset_id} (${i + 1}/${totalDatasets}):`, error);
          
          // Update status to error
          setExecutionStatuses(prev => prev.map(status => 
            status.dataset_id === dataset.dataset_id && status.script_name === scriptName
              ? { ...status, status: "error" as const, error: error.message || "Execution failed" }
              : status
          ));
        }
        
        // Continue to next dataset even on error
        warn(`[AdminScriptExecution] Error occurred for dataset ${i + 1}/${totalDatasets}, continuing to next dataset...`);
      }
    }

    setExecuting(false);
    info(`Finished executing ${scriptName} for all datasets`);
    
    // Sync with running processes before converting errors to retry
    // This catches cases where the request timed out but the process is actually running
    await syncStatusesWithRunningProcesses();
    
    // Convert error statuses to retry after all scripts complete
    // (only those that don't have running processes)
    setExecutionStatuses(prev => prev.map(status => 
      status.status === "error" && status.script_name === scriptName
        ? { ...status, status: "retry" as const }
        : status
    ));
  };

  // Update dataset descriptions (race numbers)
  const updateDescriptions = async () => {
    if (datasets().length === 0) {
      logError("No datasets to process. Please fetch datasets first.");
      return;
    }

    setExecuting(true);
    
    // Initialize statuses for all datasets
    const initialStatuses: ExecutionStatus[] = datasets().map(ds => ({
      dataset_id: ds.dataset_id,
      date: ds.date,
      source_name: ds.source_name || "",
      script_name: "Update Descriptions",
      status: "pending" as const,
      started_at: new Date().toISOString()
    }));
    setExecutionStatuses(initialStatuses);

    debug('[AdminScriptExecution] updateDescriptions called:', { 
      datasetCount: datasets().length, 
      datasetIds: datasets().map(ds => ds.dataset_id)
    });
    
    for (let i = 0; i < datasets().length; i++) {
      const dataset = datasets()[i];
      
      // Update status to running
      setExecutionStatuses(prev => prev.map(status => 
        status.dataset_id === dataset.dataset_id && status.script_name === "Update Descriptions"
          ? { ...status, status: "running" as const }
          : status
      ));

      try {
        // Fetch description (race numbers) - matching UploadDatasets.tsx logic
        const report_desc_response = await getData(
          `${apiEndpoints.app.datasets}/desc?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId()!)}&dataset_id=${encodeURIComponent(dataset.dataset_id)}`
        );

        debug('[AdminScriptExecution] Description fetch response:', { 
          datasetId: dataset.dataset_id, 
          success: report_desc_response.success, 
          data: report_desc_response.data,
          dataLength: report_desc_response.data?.length 
        });

        if (report_desc_response.success) {
          let races = report_desc_response.data;
          let description = 'TRAINING'; // Default to TRAINING when no races (only use NA for errors)

          if (races && races.length > 0) {
            // Extract race numbers from objects - matching UploadDatasets.tsx logic
            const raceNumbers = races.map((race: any) => race.races);
            
            if (raceNumbers.length === 1) {
              description = "Race " + raceNumbers[0];
            } else if (raceNumbers.length === 2) {
              description = "Races " + raceNumbers[0] + " & " + raceNumbers[1];
            } else if (raceNumbers.length === 3) {
              description = "Races " + raceNumbers[0] + ", " + raceNumbers[1] + " & " + raceNumbers[2];
            } else if (raceNumbers.length > 3) {
              // 4 or more races
              const lastRace = raceNumbers[raceNumbers.length - 1];
              const otherRaces = raceNumbers.slice(0, -1).join(", ");
              description = "Races " + otherRaces + " & " + lastRace;
            }
            
            debug('[AdminScriptExecution] Description formatted:', { datasetId: dataset.dataset_id, description, raceNumbers });
          } else {
            // No races found but fetch was successful - use TRAINING
            debug('[AdminScriptExecution] No races found, setting description to TRAINING:', { datasetId: dataset.dataset_id });
          }
          
          // Update the dataset with the description (always update when fetch was successful)
          // Fetch existing dataset to get current values
          const existingDatasetResponse = await getData(
            `${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId()!)}&dataset_id=${encodeURIComponent(dataset.dataset_id)}`
          );
          
          if (existingDatasetResponse.success && existingDatasetResponse.data) {
            const existing = existingDatasetResponse.data;
            const shared_int = existing.shared ? 1 : 0;
            const datasetTimezone = existing.timezone || 'Europe/Madrid';
            
            // Update dataset with description
            const updateResponse = await putData(`${apiEndpoints.app.datasets}`, {
              class_name: selectedClassName(),
              project_id: selectedProjectId()!,
              dataset_id: dataset.dataset_id,
              event_name: dataset.event_name || existing.event_name || '',
              report_name: existing.report_name || 'NA',
              description: description,
              timezone: datasetTimezone,
              tws: existing.tws || '',
              twd: existing.twd || '',
              shared: shared_int
            });
            
            if (updateResponse.success) {
              debug('[AdminScriptExecution] Description updated successfully:', { datasetId: dataset.dataset_id, description });
              setExecutionStatuses(prev => prev.map(status => 
                status.dataset_id === dataset.dataset_id && status.script_name === "Update Descriptions"
                  ? { ...status, status: "success" as const }
                  : status
              ));
            } else {
              warn('[AdminScriptExecution] Failed to update description:', { datasetId: dataset.dataset_id, error: updateResponse.message });
              setExecutionStatuses(prev => prev.map(status => 
                status.dataset_id === dataset.dataset_id && status.script_name === "Update Descriptions"
                  ? { ...status, status: "error" as const, error: updateResponse.message || "Update failed" }
                  : status
              ));
            }
          } else {
            warn('[AdminScriptExecution] Failed to fetch existing dataset for description update:', { datasetId: dataset.dataset_id });
            setExecutionStatuses(prev => prev.map(status => 
              status.dataset_id === dataset.dataset_id && status.script_name === "Update Descriptions"
                ? { ...status, status: "error" as const, error: "Failed to fetch existing dataset" }
                : status
            ));
          }
        } else {
          debug('[AdminScriptExecution] Description fetch failed:', { datasetId: dataset.dataset_id, message: report_desc_response.message });
          setExecutionStatuses(prev => prev.map(status => 
            status.dataset_id === dataset.dataset_id && status.script_name === "Update Descriptions"
              ? { ...status, status: "error" as const, error: report_desc_response.message || "Description fetch failed" }
              : status
          ));
        }
      } catch (error: any) {
        warn('[AdminScriptExecution] Error updating description:', { datasetId: dataset.dataset_id, error });
        setExecutionStatuses(prev => prev.map(status => 
          status.dataset_id === dataset.dataset_id && status.script_name === "Update Descriptions"
            ? { ...status, status: "error" as const, error: error.message || "Update failed" }
            : status
        ));
      }
    }

    setExecuting(false);
    info(`Finished updating descriptions for ${datasets().length} dataset(s)`);
    
    // Convert error statuses to retry after all updates complete
    setExecutionStatuses(prev => prev.map(status => 
      status.status === "error" && status.script_name === "Update Descriptions"
        ? { ...status, status: "retry" as const }
        : status
    ));

    // Also update report names (days) after descriptions are updated
    info(`[AdminScriptExecution] Starting report name updates after description updates`);
    await updateReportNames();
  };

  // Helper function to parse date string consistently
  const parseDate = (dateString: string): Date => {
    // Handle YYYY-MM-DD format
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      // Parse as local date to avoid UTC issues
      const [year, month, day] = dateString.split('-').map(Number);
      return new Date(year, month - 1, day);
    }
    // Fallback to standard Date parsing
    return new Date(dateString);
  };

  // Update dataset report names (days)
  const updateReportNames = async () => {
    if (datasets().length === 0) {
      logError("No datasets to process. Please fetch datasets first.");
      return;
    }

    setExecuting(true);
    
    // Initialize statuses for all datasets
    const initialStatuses: ExecutionStatus[] = datasets().map(ds => ({
      dataset_id: ds.dataset_id,
      date: ds.date,
      source_name: ds.source_name || "",
      script_name: "Update Report Names",
      status: "pending" as const,
      started_at: new Date().toISOString()
    }));
    setExecutionStatuses(prev => [...prev, ...initialStatuses]);

    debug('[AdminScriptExecution] updateReportNames called:', { 
      datasetCount: datasets().length, 
      datasetIds: datasets().map(ds => ds.dataset_id)
    });

    try {
      // Group datasets by event_name
      const datasetsByEvent = new Map<string, Dataset[]>();
      for (const dataset of datasets()) {
        const eventName = dataset.event_name || 'UNKNOWN';
        if (!datasetsByEvent.has(eventName)) {
          datasetsByEvent.set(eventName, []);
        }
        datasetsByEvent.get(eventName)!.push(dataset);
      }

      info(`[AdminScriptExecution] Processing ${datasetsByEvent.size} event(s) for report name updates`);
      debug(`[AdminScriptExecution] Dataset grouping by event:`, Array.from(datasetsByEvent.entries()).map(([eventName, datasets]) => ({
        eventName,
        count: datasets.length,
        dates: datasets.map(d => d.date).sort()
      })));

      // Helper function to normalize date format (YYYYMMDD -> YYYY-MM-DD)
      const normalizeDate = (date: string): string => {
        if (date.includes('-')) {
          return date; // Already in YYYY-MM-DD format
        }
        // Convert YYYYMMDD to YYYY-MM-DD
        if (date.length === 8) {
          return `${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)}`;
        }
        return date; // Return as-is if format is unexpected
      };

      // Helper function to check if boundaries exist for a date
      const checkBoundariesExist = async (date: string): Promise<boolean> => {
        try {
          const className = selectedClassName();
          const projectId = selectedProjectId()!;
          const dateStr = normalizeDate(date);
          
          const response = await getData(
            `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateStr)}&object_name=boundaries`
          );
          
          return response.success && response.data && 
                 (Object.keys(response.data).length > 0 || (Array.isArray(response.data) && response.data.length > 0));
        } catch (error) {
          debug('[AdminScriptExecution] Error checking boundaries (assuming no boundaries):', error);
          return false;
        }
      };

      // Process each event
      for (const [eventName, eventDatasets] of datasetsByEvent.entries()) {
        debug(`[AdminScriptExecution] Processing event: ${eventName} with ${eventDatasets.length} dataset(s)`);

        // Get unique dates from all datasets in this event
        const uniqueDates = Array.from(new Set(eventDatasets.map(d => d.date)))
          .sort((a, b) => parseDate(a).getTime() - parseDate(b).getTime());

        // Categorize dates into three groups
        const practiceDates: string[] = [];
        const officialPracticeDates: string[] = [];
        const raceDates: string[] = [];

        // Check each unique date for races and boundaries
        for (const date of uniqueDates) {
          // Find all datasets for this date
          const datasetsForDate = eventDatasets.filter(d => d.date === date);
          
          // Check if any dataset on this date has races
          let hasRaces = false;
          for (const dataset of datasetsForDate) {
            // Update status to running
            setExecutionStatuses(prev => prev.map(status => 
              status.dataset_id === dataset.dataset_id && status.script_name === "Update Report Names"
                ? { ...status, status: "running" as const }
                : status
            ));

            try {
              const report_desc_response = await getData(
                `${apiEndpoints.app.datasets}/desc?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId()!)}&dataset_id=${encodeURIComponent(dataset.dataset_id)}`
              );

              if (report_desc_response.success) {
                const races = report_desc_response.data;
                const hasValidRaces = races && races.length > 0 && races.some((race: any) => {
                  const raceNum = race.races;
                  // Exclude training races (race number -1 or 'TRAINING')
                  return raceNum !== -1 && raceNum !== '-1' && raceNum !== 'TRAINING' && raceNum !== 'training';
                });
                
                if (hasValidRaces) {
                  hasRaces = true;
                  break; // Found at least one dataset with races, no need to check others
                }
              }
            } catch (error: any) {
              debug(`[AdminScriptExecution] Error checking races for dataset ${dataset.dataset_id}:`, error);
              // Continue checking other datasets
            }
          }

          // Categorize the date
          if (!hasRaces) {
            practiceDates.push(date);
          } else {
            // Check for boundaries
            const hasBoundaries = await checkBoundariesExist(date);
            if (hasBoundaries) {
              raceDates.push(date);
            } else {
              officialPracticeDates.push(date);
            }
          }
        }

        // Create mappings from date to sequential number for each category
        const dateToPracticeNumber = new Map<string, number>();
        practiceDates.forEach((date, index) => {
          dateToPracticeNumber.set(date, index + 1);
        });

        const dateToOfficialPracticeNumber = new Map<string, number>();
        officialPracticeDates.forEach((date, index) => {
          dateToOfficialPracticeNumber.set(date, index + 1);
        });

        const dateToRaceNumber = new Map<string, number>();
        raceDates.forEach((date, index) => {
          dateToRaceNumber.set(date, index + 1);
        });

        debug(`[AdminScriptExecution] Event ${eventName}: ${practiceDates.length} practice date(s), ${officialPracticeDates.length} official practice date(s), ${raceDates.length} race date(s)`);
        debug(`[AdminScriptExecution] Practice dates (sorted):`, practiceDates.map((date, idx) => ({ practiceNumber: idx + 1, date })));
        debug(`[AdminScriptExecution] Official Practice dates (sorted):`, officialPracticeDates.map((date, idx) => ({ officialPracticeNumber: idx + 1, date })));
        debug(`[AdminScriptExecution] Race dates (sorted):`, raceDates.map((date, idx) => ({ raceNumber: idx + 1, date })));

        // Update report names for all datasets
        for (const dataset of eventDatasets) {
          let reportName = 'NA';
          
          // Determine report name based on category
          if (dateToPracticeNumber.has(dataset.date)) {
            reportName = `Practice ${dateToPracticeNumber.get(dataset.date)}`;
          } else if (dateToOfficialPracticeNumber.has(dataset.date)) {
            reportName = `Official Practice ${dateToOfficialPracticeNumber.get(dataset.date)}`;
          } else if (dateToRaceNumber.has(dataset.date)) {
            reportName = `Race ${dateToRaceNumber.get(dataset.date)}`;
          } else {
            warn(`[AdminScriptExecution] Could not find category for date ${dataset.date} in dataset ${dataset.dataset_id}`);
            continue;
          }
          
          debug(`[AdminScriptExecution] Updating dataset ${dataset.dataset_id} (date: ${dataset.date}) to report_name: ${reportName}`);

          try {
            // Fetch existing dataset to get current values
            const existingDatasetResponse = await getData(
              `${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId()!)}&dataset_id=${encodeURIComponent(dataset.dataset_id)}`
            );

            if (existingDatasetResponse.success && existingDatasetResponse.data) {
              const existing = existingDatasetResponse.data;
              const shared_int = existing.shared ? 1 : 0;
              const datasetTimezone = existing.timezone || 'Europe/Madrid';
              
              debug(`[AdminScriptExecution] Current report_name for dataset ${dataset.dataset_id}: "${existing.report_name || 'NA'}" -> New: "${reportName}"`);

              // Update dataset with report_name
              const updatePayload = {
                class_name: selectedClassName(),
                project_id: selectedProjectId()!,
                dataset_id: dataset.dataset_id,
                event_name: dataset.event_name || existing.event_name || '',
                report_name: reportName,
                description: existing.description || 'NA',
                timezone: datasetTimezone,
                tws: existing.tws || '',
                twd: existing.twd || '',
                shared: shared_int
              };
              
              debug(`[AdminScriptExecution] Updating dataset ${dataset.dataset_id} with payload:`, updatePayload);
              
              const updateResponse = await putData(`${apiEndpoints.app.datasets}`, updatePayload);

              if (updateResponse.success) {
                // Verify the update by fetching the dataset again
                const verifyResponse = await getData(
                  `${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId()!)}&dataset_id=${encodeURIComponent(dataset.dataset_id)}`
                );
                if (verifyResponse.success && verifyResponse.data) {
                  const verifiedReportName = verifyResponse.data.report_name;
                  if (verifiedReportName === reportName) {
                    info(`[AdminScriptExecution] ✓ Report name updated and verified: dataset ${dataset.dataset_id} (date: ${dataset.date}) -> "${reportName}"`);
                  } else {
                    warn(`[AdminScriptExecution] ⚠ Report name update may have failed: dataset ${dataset.dataset_id} - Expected "${reportName}" but got "${verifiedReportName}"`);
                  }
                }
                debug(`[AdminScriptExecution] Update response:`, updateResponse);
                setExecutionStatuses(prev => prev.map(status => 
                  status.dataset_id === dataset.dataset_id && status.script_name === "Update Report Names"
                    ? { ...status, status: "success" as const }
                    : status
                ));
              } else {
                warn(`[AdminScriptExecution] ✗ Failed to update report name for dataset ${dataset.dataset_id}:`, updateResponse.message);
                debug(`[AdminScriptExecution] Update response (failed):`, updateResponse);
                setExecutionStatuses(prev => prev.map(status => 
                  status.dataset_id === dataset.dataset_id && status.script_name === "Update Report Names"
                    ? { ...status, status: "error" as const, error: updateResponse.message || "Update failed" }
                    : status
                ));
              }
            } else {
              warn(`[AdminScriptExecution] Failed to fetch existing dataset for report name update: ${dataset.dataset_id}`);
              setExecutionStatuses(prev => prev.map(status => 
                status.dataset_id === dataset.dataset_id && status.script_name === "Update Report Names"
                  ? { ...status, status: "error" as const, error: "Failed to fetch existing dataset" }
                  : status
              ));
            }
          } catch (error: any) {
            warn(`[AdminScriptExecution] Error updating report name for dataset ${dataset.dataset_id}:`, error);
            setExecutionStatuses(prev => prev.map(status => 
              status.dataset_id === dataset.dataset_id && status.script_name === "Update Report Names"
                ? { ...status, status: "error" as const, error: error.message || "Update failed" }
                : status
            ));
          }
          
          // Small delay between updates to avoid database locking issues
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Small delay between events to avoid database locking issues
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      info(`Finished updating report names for ${datasets().length} dataset(s)`);
    } catch (error: any) {
      logError('[AdminScriptExecution] Error in updateReportNames:', error);
    } finally {
      setExecuting(false);
      
      // Convert error statuses to retry after all updates complete
      setExecutionStatuses(prev => prev.map(status => 
        status.status === "error" && status.script_name === "Update Report Names"
          ? { ...status, status: "retry" as const }
          : status
      ));
    }
  };

  // Populate/update Postgres channels table for the fetched datasets (gp50 only). One status row per date.
  const updateChannels = async () => {
    if (selectedClassName() !== 'gp50') {
      setChannelUpdateMessage('Channel update is only supported for gp50.');
      return;
    }
    if (datasets().length === 0) {
      setChannelUpdateMessage('Fetch datasets first, then click Update channels.');
      return;
    }

    const ds = datasets();
    const dateKeys = new Set<string>();
    const datesForApi: Array<{ date: string; source_id: number }> = [];
    const uniqueNormalizedDates: string[] = [];
    for (const d of ds) {
      const normalizedDate = d.date.replace(/[-/]/g, '');
      const key = `${normalizedDate}_${d.source_id}`;
      if (!dateKeys.has(key)) {
        dateKeys.add(key);
        datesForApi.push({ date: normalizedDate, source_id: d.source_id });
      }
      if (!uniqueNormalizedDates.includes(normalizedDate)) {
        uniqueNormalizedDates.push(normalizedDate);
      }
    }

    // One execution status per unique date (use first dataset for that date for display)
    const initialStatuses: ExecutionStatus[] = uniqueNormalizedDates.map((normDate) => {
      const firstForDate = ds.find((d) => d.date.replace(/[-/]/g, '') === normDate)!;
      return {
        dataset_id: firstForDate.dataset_id,
        date: firstForDate.date,
        source_name: firstForDate.source_name || normDate,
        script_name: "Update channels",
        status: "pending" as const,
        started_at: new Date().toISOString()
      };
    });
    setExecutionStatuses((prev) => [...prev, ...initialStatuses]);
    setExecuting(true);
    setUpdatingChannels(true);
    setChannelUpdateMessage(null);

    // Mark Update channels rows as running
    setExecutionStatuses((prev) =>
      prev.map((s) =>
        s.script_name === "Update channels" && initialStatuses.some((i) => i.dataset_id === s.dataset_id && i.date === s.date)
          ? { ...s, status: "running" as const }
          : s
      )
    );

    try {
      debug('[AdminScriptExecution] Update channels: calling populate with', { count: datesForApi.length, dates: datesForApi });
      const response = await postData(
        `${apiEndpoints.app.datasets}/channels/populate`,
        {
          class_name: selectedClassName(),
          project_id: selectedProjectId(),
          dates: datesForApi,
          force_refresh: true
        }
      );

      if (response.success && response.data) {
        const data = response.data as {
          processed?: number;
          error_count?: number;
          results?: Array<{ date: string; source_id: number; fileChannels?: number; influxChannels?: number; error?: string }>;
          errors?: Array<{ date: string; source_id: number; error: string }>;
        };
        const results = data.results ?? [];
        const errors = data.errors ?? [];
        setExecutionStatuses((prev) =>
          prev.map((s) => {
            if (s.script_name !== "Update channels") return s;
            const norm = s.date.replace(/[-/]/g, "");
            const dateErrors = errors.filter((e) => e.date === norm);
            const dateResults = results.filter((r) => r.date === norm);
            if (dateErrors.length > 0) {
              return { ...s, status: "error" as const, error: dateErrors.map((e) => e.error).join("; ") };
            }
            if (dateResults.length > 0) {
              return { ...s, status: "success" as const, error: undefined };
            }
            return s;
          })
        );
        const processed = data.processed ?? 0;
        const errCount = data.error_count ?? errors.length;
        const msg = `Channels updated: ${processed} date/source(s) processed${errCount > 0 ? `, ${errCount} error(s)` : ""}.`;
        setChannelUpdateMessage(msg);
        info('[AdminScriptExecution]', msg, data);
      } else {
        const msg = response.message || "Channel update failed.";
        setChannelUpdateMessage(`Error: ${msg}`);
        setExecutionStatuses((prev) =>
          prev.map((s) =>
            s.script_name === "Update channels" && initialStatuses.some((i) => i.dataset_id === s.dataset_id && i.date === s.date)
              ? { ...s, status: "error" as const, error: msg }
              : s
          )
        );
        logError('[AdminScriptExecution] Update channels failed:', msg);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      setChannelUpdateMessage(`Error: ${msg}`);
      setExecutionStatuses((prev) =>
        prev.map((s) =>
          s.script_name === "Update channels" && initialStatuses.some((i) => i.dataset_id === s.dataset_id && i.date === s.date)
            ? { ...s, status: "error" as const, error: msg }
            : s
        )
      );
      logError('[AdminScriptExecution] Update channels error:', error);
    } finally {
      setExecuting(false);
      setUpdatingChannels(false);
    }
  };

  // Run 4_cleanup.py for each unique date (day-level VMG + race position). One status row per date.
  const runCleanup = async () => {
    if (selectedClassName() !== 'gp50') {
      setCleanupMessage('Cleanup is only supported for gp50.');
      return;
    }
    if (datasets().length === 0) {
      setCleanupMessage('Fetch datasets first, then click Run cleanup.');
      return;
    }

    const ds = datasets();
    const uniqueNormalizedDates: string[] = [];
    const dateKeys = new Set<string>();
    for (const d of ds) {
      const normalizedDate = d.date.replace(/[-/]/g, '');
      if (!dateKeys.has(normalizedDate)) {
        dateKeys.add(normalizedDate);
        uniqueNormalizedDates.push(normalizedDate);
      }
    }

    const initialStatuses: ExecutionStatus[] = uniqueNormalizedDates.map((normDate) => {
      const firstForDate = ds.find((d) => d.date.replace(/[-/]/g, '') === normDate)!;
      return {
        dataset_id: firstForDate.dataset_id,
        date: firstForDate.date,
        source_name: firstForDate.source_name || normDate,
        script_name: '4_cleanup.py',
        status: 'pending' as const,
        started_at: new Date().toISOString()
      };
    });
    setExecutionStatuses((prev) => [...prev, ...initialStatuses]);
    setExecuting(true);
    setUpdatingCleanup(true);
    setCleanupMessage(null);

    setExecutionStatuses((prev) =>
      prev.map((s) =>
        s.script_name === '4_cleanup.py' && initialStatuses.some((i) => i.dataset_id === s.dataset_id && i.date === s.date)
          ? { ...s, status: 'running' as const }
          : s
      )
    );

    try {
      info(
        `[AdminScriptExecution] Run cleanup: ${uniqueNormalizedDates.length} unique date(s)${cleanupPagesOnly() ? " (pages_only)" : ""}`
      );
      for (let i = 0; i < uniqueNormalizedDates.length; i++) {
        const dateNorm = uniqueNormalizedDates[i];
        const statusForDate = initialStatuses[i];
        const datasetId = statusForDate.dataset_id;

        setCleanupMessage(`Cleanup (${i + 1}/${uniqueNormalizedDates.length}): ${dateNorm}...`);
        debug('[AdminScriptExecution] Run cleanup: calling execute_script for date', dateNorm);

        try {
          const payload = {
            project_id: selectedProjectId()!.toString(),
            class_name: selectedClassName(),
            script_name: '4_cleanup.py',
            parameters: {
              class_name: selectedClassName(),
              project_id: selectedProjectId()!.toString(),
              date: dateNorm,
              verbose: false,
              pages_only: cleanupPagesOnly()
            }
          };
          const response_json = await postData(apiEndpoints.python.execute_script, payload);
          const pid = response_json?.process_id ?? response_json?.data?.process_id;

          if (pid) {
            processStore.startProcess(pid, 'script_execution');
            processStore.setShowToast(pid, false);
            await waitForProcessCompletion(pid, datasetId, '4_cleanup.py');
          } else {
            const msg = (response_json as { message?: string })?.message || 'No process_id returned';
            setExecutionStatuses((prev) =>
              prev.map((s) =>
                s.script_name === '4_cleanup.py' && s.dataset_id === datasetId && s.date === statusForDate.date
                  ? { ...s, status: 'error' as const, error: msg }
                  : s
              )
            );
            warn('[AdminScriptExecution] Run cleanup: no process_id for date', dateNorm, msg);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setExecutionStatuses((prev) =>
            prev.map((s) =>
              s.script_name === '4_cleanup.py' && s.dataset_id === datasetId && s.date === statusForDate.date
                ? { ...s, status: 'error' as const, error: msg }
                : s
            )
          );
          logError('[AdminScriptExecution] Run cleanup failed for date', dateNorm, err);
        }

        if (i < uniqueNormalizedDates.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      const statusesAfter = executionStatuses();
      const cleanupStatuses = statusesAfter.filter((s) => s.script_name === '4_cleanup.py' && initialStatuses.some((i) => i.dataset_id === s.dataset_id && i.date === s.date));
      const successCount = cleanupStatuses.filter((s) => s.status === 'success').length;
      const errorCount = cleanupStatuses.filter((s) => s.status === 'error').length;
      const msg = `Cleanup finished: ${successCount} date(s) ok${errorCount > 0 ? `, ${errorCount} error(s)` : ''}.`;
      setCleanupMessage(msg);
      info('[AdminScriptExecution]', msg);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      setCleanupMessage(`Error: ${msg}`);
      logError('[AdminScriptExecution] Run cleanup error:', error);
    } finally {
      setExecuting(false);
      setUpdatingCleanup(false);
    }
  };

  // Run 5_markwind.py for each unique date (build/post markwind from Influx MDSS). Fetches timezone per date.
  const runMarkwind = async () => {
    if (datasets().length === 0 || !selectedProjectId() || !selectedClassName()) {
      logError("No datasets or project selected. Fetch datasets first.");
      return;
    }
    if (selectedClassName() !== "gp50") {
      logError("Markwind script is only supported for gp50.");
      return;
    }

    const ds = datasets();
    const uniqueNormalizedDates: string[] = [];
    const dateKeys = new Set<string>();
    for (const d of ds) {
      const normalizedDate = d.date.replace(/[-/]/g, "");
      if (!dateKeys.has(normalizedDate)) {
        dateKeys.add(normalizedDate);
        uniqueNormalizedDates.push(normalizedDate);
      }
    }

    const initialStatuses: ExecutionStatus[] = uniqueNormalizedDates.map((normDate) => {
      const firstForDate = ds.find((d) => d.date.replace(/[-/]/g, "") === normDate)!;
      return {
        dataset_id: firstForDate.dataset_id,
        date: firstForDate.date,
        source_name: firstForDate.source_name || normDate,
        script_name: "5_markwind.py",
        status: "pending" as const,
        started_at: new Date().toISOString(),
      };
    });
    setExecutionStatuses((prev) => [...prev, ...initialStatuses]);
    setExecuting(true);
    setUpdatingMarkwind(true);
    setMarkwindMessage(null);

    setExecutionStatuses((prev) =>
      prev.map((s) =>
        s.script_name === "5_markwind.py" && initialStatuses.some((i) => i.dataset_id === s.dataset_id && i.date === s.date)
          ? { ...s, status: "running" as const }
          : s
      )
    );

    try {
      info(`[AdminScriptExecution] Run markwind: ${uniqueNormalizedDates.length} unique date(s)`);
      for (let i = 0; i < uniqueNormalizedDates.length; i++) {
        const dateNorm = uniqueNormalizedDates[i];
        const statusForDate = initialStatuses[i];
        const datasetId = statusForDate.dataset_id;

        setMarkwindMessage(`Markwind (${i + 1}/${uniqueNormalizedDates.length}): ${dateNorm}...`);
        debug("[AdminScriptExecution] Run markwind: fetching timezone for date", dateNorm);

        let timezone = "Europe/Madrid";
        try {
          const tz = await getTimezoneForDate(selectedClassName()!, selectedProjectId()!, dateNorm);
          if (tz) timezone = tz;
          debug("[AdminScriptExecution] Run markwind: timezone for", dateNorm, "=", timezone);
        } catch (tzErr) {
          warn("[AdminScriptExecution] Run markwind: timezone fetch failed for", dateNorm, tzErr);
        }

        try {
          const payload = {
            project_id: selectedProjectId()!.toString(),
            class_name: selectedClassName(),
            script_name: "5_markwind.py",
            parameters: {
              class_name: selectedClassName(),
              project_id: selectedProjectId()!,
              date: dateNorm,
              timezone,
            },
          };
          const response_json = await postData(apiEndpoints.python.execute_script, payload);
          const pid = response_json?.process_id ?? response_json?.data?.process_id;

          if (pid) {
            processStore.startProcess(pid, "script_execution");
            processStore.setShowToast(pid, false);
            await waitForProcessCompletion(pid, datasetId, "5_markwind.py");
          } else {
            const msg = (response_json as { message?: string })?.message || "No process_id returned";
            setExecutionStatuses((prev) =>
              prev.map((s) =>
                s.script_name === "5_markwind.py" && s.dataset_id === datasetId && s.date === statusForDate.date
                  ? { ...s, status: "error" as const, error: msg }
                  : s
              )
            );
            warn("[AdminScriptExecution] Run markwind: no process_id for date", dateNorm, msg);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setExecutionStatuses((prev) =>
            prev.map((s) =>
              s.script_name === "5_markwind.py" && s.dataset_id === datasetId && s.date === statusForDate.date
                ? { ...s, status: "error" as const, error: msg }
                : s
            )
          );
          logError("[AdminScriptExecution] Run markwind failed for date", dateNorm, err);
        }

        if (i < uniqueNormalizedDates.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      const statusesAfter = executionStatuses();
      const markwindStatuses = statusesAfter.filter(
        (s) => s.script_name === "5_markwind.py" && initialStatuses.some((i) => i.dataset_id === s.dataset_id && i.date === s.date)
      );
      const successCount = markwindStatuses.filter((s) => s.status === "success").length;
      const errorCount = markwindStatuses.filter((s) => s.status === "error").length;
      const msg = `Markwind finished: ${successCount} date(s) ok${errorCount > 0 ? `, ${errorCount} error(s)` : ""}.`;
      setMarkwindMessage(msg);
      info("[AdminScriptExecution]", msg);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      setMarkwindMessage(`Error: ${msg}`);
      logError("[AdminScriptExecution] Run markwind error:", error);
    } finally {
      setExecuting(false);
      setUpdatingMarkwind(false);
    }
  };

  // Wait for process to complete
  const waitForProcessCompletion = (pid: string, datasetId: number, scriptName: string): Promise<void> => {
    return new Promise((resolve) => {
      let checkCount = 0;
      const maxChecks = 9000; // 75 minutes at 500ms intervals (scripts can take up to 60 minutes)
      let lastStatus: string | null = null;
      let lastRunningCheck = 0;
      let lastSSEUpdate = Date.now(); // Track when we last received an SSE update
      const runningCheckInterval = 10000; // Check running processes endpoint every 10 seconds normally
      const fastRunningCheckInterval = 2000; // Check every 2 seconds when SSE hasn't updated
      const sseStaleThreshold = 30000; // If SSE hasn't updated in 30 seconds, use fast polling
      const startTime = Date.now();
      
      debug(`[AdminScriptExecution] Starting to wait for process ${pid} (dataset ${datasetId}, script ${scriptName})`);
      
      const maxTimeout = setTimeout(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        warn(`[AdminScriptExecution] Process ${pid} timeout after ${elapsed}s (75 minutes)`);
        setExecutionStatuses(prev => prev.map(status => 
          status.dataset_id === datasetId && status.script_name === scriptName
            ? { ...status, status: "error" as const, error: "Process timeout" }
            : status
        ));
        resolve();
      }, 4500000); // 75 minute timeout (scripts can take up to 60 minutes: 30 min processing + 30 min execution)

      // Note: We rely on SSE for status updates, but also poll running processes API as fallback
      // This handles cases where SSE connection is lost or messages are delayed

      const checkCompletion = async () => {
        checkCount++;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const process = processStore.getProcess(pid);
        
        // Update last SSE update time if process status or messages changed
        if (process) {
          const currentTimestamp = process.timestamp || 0;
          if (currentTimestamp > lastSSEUpdate) {
            lastSSEUpdate = currentTimestamp;
          }
        }
        
        // Log detailed status every 10 checks (5 seconds) or on status change
        if (checkCount % 10 === 0 || (process && process.status !== lastStatus)) {
          const allProcesses = processStore.getAllProcesses();
          const runningProcesses = allProcesses.filter(p => p.status === 'running');
          const timeSinceLastSSEUpdate = Date.now() - lastSSEUpdate;
          const sseIsStale = timeSinceLastSSEUpdate > sseStaleThreshold;
          debug(`[AdminScriptExecution] Check #${checkCount} (${elapsed}s) for process ${pid}:`, {
            processFound: !!process,
            processStatus: process?.status || 'NOT_FOUND',
            processType: process?.type,
            processMessages: process?.messages?.length || 0,
            latestMessage: process?.latestMessage || 'N/A',
            sseConnected: sseManager.isConnected(8049),
            sseStale: sseIsStale,
            timeSinceLastSSEUpdate: `${(timeSinceLastSSEUpdate / 1000).toFixed(1)}s`,
            totalRunningProcesses: runningProcesses.length,
            runningPids: runningProcesses.map(p => p.process_id)
          });
        }
        
        // Log status changes for debugging
        if (process && process.status !== lastStatus) {
          debug(`[AdminScriptExecution] Process ${pid} status changed: ${lastStatus} -> ${process.status} (${elapsed}s)`);
          lastStatus = process.status;
        }
        
        if (process) {
          if (process.status === 'complete') {
            clearTimeout(maxTimeout);
            debug(`[AdminScriptExecution] Process ${pid} completed successfully after ${elapsed}s`);
            setExecutionStatuses(prev => prev.map(status => 
              status.dataset_id === datasetId && status.script_name === scriptName
                ? { ...status, status: "success" as const }
                : status
            ));
            resolve();
            return;
          } else if (process.status === 'error' || process.status === 'timeout') {
            clearTimeout(maxTimeout);
            warn(`[AdminScriptExecution] Process ${pid} failed with status: ${process.status} after ${elapsed}s`);
            setExecutionStatuses(prev => prev.map(status => 
              status.dataset_id === datasetId && status.script_name === scriptName
                ? { ...status, status: "error" as const, error: process.status }
                : status
            ));
            resolve();
            return;
          }
        }
        
        // Determine if SSE is stale (hasn't updated recently)
        const timeSinceLastSSEUpdate = Date.now() - lastSSEUpdate;
        const sseIsStale = timeSinceLastSSEUpdate > sseStaleThreshold;
        
        // Use faster polling if SSE is stale or process not found
        const currentCheckInterval = (sseIsStale || !process) ? fastRunningCheckInterval : runningCheckInterval;
        
        // Fallback: Check running processes API when SSE is stale or periodically
        const now = Date.now();
        if (now - lastRunningCheck >= currentCheckInterval) {
          lastRunningCheck = now;
          try {
            const runningCheck = await getData(apiEndpoints.python.running_processes);
            if (runningCheck?.success && runningCheck?.data) {
              const runningProcesses = runningCheck.data.processes || [];
              const isStillRunning = runningProcesses.some((p: any) => p.process_id === pid);
              
              if (!isStillRunning) {
                // Process is not in running list - check final status
                const finalProcess = processStore.getProcess(pid);
                if (finalProcess && (finalProcess.status === 'error' || finalProcess.status === 'timeout')) {
                  clearTimeout(maxTimeout);
                  warn(`[AdminScriptExecution] Process ${pid} not found in running list and has error status: ${finalProcess.status}`);
                  setExecutionStatuses(prev => prev.map(status => 
                    status.dataset_id === datasetId && status.script_name === scriptName
                      ? { ...status, status: "error" as const, error: finalProcess.status }
                      : status
                  ));
                  resolve();
                  return;
                } else {
                  // Assume completion if not in running list and no error status
                  clearTimeout(maxTimeout);
                  debug(`[AdminScriptExecution] Process ${pid} not found in running processes list, assuming completion (${elapsed}s, sseStale: ${sseIsStale})`);
                  processStore.completeProcess(pid, 'complete');
                  setExecutionStatuses(prev => prev.map(status => 
                    status.dataset_id === datasetId && status.script_name === scriptName
                      ? { ...status, status: "success" as const }
                      : status
                  ));
                  resolve();
                  return;
                }
              } else {
                // Process is still running - log if SSE is stale
                if (sseIsStale) {
                  debug(`[AdminScriptExecution] Process ${pid} still running (checked via API, SSE stale):`, {
                    elapsed: `${elapsed}s`,
                    timeSinceLastSSEUpdate: `${(timeSinceLastSSEUpdate / 1000).toFixed(1)}s`
                  });
                }
              }
            }
          } catch (error) {
            warn(`[AdminScriptExecution] Error checking running processes for ${pid}:`, error);
            // Continue with normal polling
          }
        }
        
        // Still running - verify SSE connection is still active periodically
        if (checkCount % 20 === 0) { // Every 10 seconds, verify SSE connection
          const sseConnected = sseManager.isConnected(8049);
          if (!sseConnected) {
            warn(`[AdminScriptExecution] SSE connection lost for port 8049, reconnecting...`);
            const reconnectResult = await sseManager.connectToServer(8049);
            debug(`[AdminScriptExecution] SSE reconnection result: ${reconnectResult}`);
          }
        }
        
        // Continue checking
        if (checkCount < maxChecks) {
          setTimeout(checkCompletion, 500);
        } else {
          // Max checks reached - timeout
          warn(`[AdminScriptExecution] Max checks reached for ${pid} after ${elapsed}s - process may still be running`);
          clearTimeout(maxTimeout);
          setExecutionStatuses(prev => prev.map(status => 
            status.dataset_id === datasetId && status.script_name === scriptName
              ? { ...status, status: "error" as const, error: "Process status check timeout - check server logs" }
              : status
          ));
          resolve();
        }
      };

      // Start checking immediately
      checkCompletion();
    });
  };

  // Retry script execution for a specific dataset
  const retryScript = async (status: ExecutionStatus) => {
    if (!selectedProjectId() || !selectedClassName()) {
      logError("Cannot retry: Project or class name not set");
      return;
    }

    // Find the dataset
    const dataset = datasets().find(ds => ds.dataset_id === status.dataset_id);
    if (!dataset) {
      logError(`Cannot retry: Dataset ${status.dataset_id} not found`);
      return;
    }

    // Update status to running
    setExecutionStatuses(prev => prev.map(s => 
      s.dataset_id === status.dataset_id && s.script_name === status.script_name
        ? { ...s, status: "running" as const, error: undefined }
        : s
    ));

    try {
      // Handle "Update Descriptions" differently
      if (status.script_name === "Update Descriptions") {
        // Fetch description (race numbers) - matching updateDescriptions logic
        const report_desc_response = await getData(
          `${apiEndpoints.app.datasets}/desc?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId()!)}&dataset_id=${encodeURIComponent(dataset.dataset_id)}`
        );

        if (report_desc_response.success) {
          let races = report_desc_response.data;
          let description = 'NA';

          if (races && races.length > 0) {
            // Extract race numbers from objects
            const raceNumbers = races.map((race: any) => race.races);
            
            if (raceNumbers.length === 1) {
              description = "Race " + raceNumbers[0];
            } else if (raceNumbers.length === 2) {
              description = "Races " + raceNumbers[0] + " & " + raceNumbers[1];
            } else if (raceNumbers.length === 3) {
              description = "Races " + raceNumbers[0] + ", " + raceNumbers[1] + " & " + raceNumbers[2];
            } else if (raceNumbers.length > 3) {
              const lastRace = raceNumbers[raceNumbers.length - 1];
              const otherRaces = raceNumbers.slice(0, -1).join(", ");
              description = "Races " + otherRaces + " & " + lastRace;
            }
            
            // Update the dataset with the description
            if (description !== 'NA') {
              // Fetch existing dataset to get current values
              const existingDatasetResponse = await getData(
                `${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId()!)}&dataset_id=${encodeURIComponent(dataset.dataset_id)}`
              );
              
              if (existingDatasetResponse.success && existingDatasetResponse.data) {
                const existing = existingDatasetResponse.data;
                const shared_int = existing.shared ? 1 : 0;
                const datasetTimezone = existing.timezone || 'Europe/Madrid';
                
                // Update dataset with description
                const updateResponse = await putData(`${apiEndpoints.app.datasets}`, {
                  class_name: selectedClassName(),
                  project_id: selectedProjectId()!,
                  dataset_id: dataset.dataset_id,
                  event_name: dataset.event_name || existing.event_name || '',
                  report_name: existing.report_name || 'NA',
                  description: description,
                  timezone: datasetTimezone,
                  tws: existing.tws || '',
                  twd: existing.twd || '',
                  shared: shared_int
                });
                
                if (updateResponse.success) {
                  setExecutionStatuses(prev => prev.map(s => 
                    s.dataset_id === status.dataset_id && s.script_name === status.script_name
                      ? { ...s, status: "success" as const }
                      : s
                  ));
                } else {
                  throw new Error(updateResponse.message || "Update failed");
                }
              } else {
                throw new Error("Failed to fetch existing dataset");
              }
            } else {
              setExecutionStatuses(prev => prev.map(s => 
                s.dataset_id === status.dataset_id && s.script_name === status.script_name
                  ? { ...s, status: "success" as const }
                  : s
              ));
            }
          } else {
            setExecutionStatuses(prev => prev.map(s => 
              s.dataset_id === status.dataset_id && s.script_name === status.script_name
                ? { ...s, status: "success" as const }
                : s
            ));
          }
        } else {
          throw new Error(report_desc_response.message || "Description fetch failed");
        }
      } else if (status.script_name === "Update Report Names") {
        // For report names, we need to re-run the entire function since day numbers
        // depend on the ordering of all datasets in the event
        info(`[AdminScriptExecution] Retrying Update Report Names for all datasets (day numbers depend on event ordering)`);
        await updateReportNames();
      } else if (status.script_name === "4_cleanup.py") {
        // Day-level cleanup: parameters are class_name, project_id, date, verbose
        const dateNorm = dataset.date.replace(/[-/]/g, "");
        const parameters = {
          class_name: selectedClassName(),
          project_id: selectedProjectId()!.toString(),
          date: dateNorm,
          verbose: false
        };
        const payload = {
          project_id: selectedProjectId()!.toString(),
          class_name: selectedClassName(),
          script_name: "4_cleanup.py",
          parameters
        };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000);
        let response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
        clearTimeout(timeoutId);
        if (response_json?.type === 'AbortError' || response_json?.message === 'Request cancelled') {
          throw new Error(`Request timeout for 4_cleanup.py on date ${dataset.date} - script may still be running`);
        }
        const pid = response_json?.process_id ?? response_json?.data?.process_id;
        if (pid) {
          processStore.startProcess(pid, 'script_execution');
          processStore.setShowToast(pid, false);
          await waitForProcessCompletion(pid, status.dataset_id, '4_cleanup.py');
        } else {
          throw new Error((response_json as { message?: string })?.message || 'No process_id returned');
        }
      } else if (status.script_name === "5_markwind.py") {
        // Day-level markwind: parameters are class_name, project_id, date, timezone
        const dateNorm = dataset.date.replace(/[-/]/g, "");
        let timezone = "Europe/Madrid";
        try {
          const tz = await getTimezoneForDate(selectedClassName()!, selectedProjectId()!, dateNorm);
          if (tz) timezone = tz;
        } catch {
          // keep default
        }
        const parameters = {
          class_name: selectedClassName(),
          project_id: selectedProjectId()!,
          date: dateNorm,
          timezone
        };
        const payload = {
          project_id: selectedProjectId()!.toString(),
          class_name: selectedClassName(),
          script_name: "5_markwind.py",
          parameters
        };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000);
        let response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
        clearTimeout(timeoutId);
        if (response_json?.type === 'AbortError' || response_json?.message === 'Request cancelled') {
          throw new Error(`Request timeout for 5_markwind.py on date ${dataset.date} - script may still be running`);
        }
        const pid = response_json?.process_id ?? response_json?.data?.process_id;
        if (pid) {
          processStore.startProcess(pid, 'script_execution');
          processStore.setShowToast(pid, false);
          await waitForProcessCompletion(pid, status.dataset_id, '5_markwind.py');
        } else {
          throw new Error((response_json as { message?: string })?.message || 'No process_id returned');
        }
      } else {
        // Handle regular script execution (e.g. 3_execute.py)
        const sanitizedDate = dataset.date.replace(/[-/]/g, "");
        
        // Get source name for this dataset
        const source = sources().find(s => s.source_id === dataset.source_id);
        const sourceName = source?.source_name || "";

        // Match UploadDatasets.tsx for 1_normalization_influx.py; otherwise include dataset_id, batch, verbose, and start_time/end_time for 3_execute
        const isNormalizeInfluxRetry = status.script_name === '1_normalization_influx.py';
        const parameters: Record<string, string | number | boolean | null> = isNormalizeInfluxRetry
          ? {
              project_id: selectedProjectId()!,
              class_name: selectedClassName(),
              date: sanitizedDate,
              source_name: sourceName,
              timezone: dataset.timezone ?? 'Europe/Madrid'
            }
          : {
              project_id: selectedProjectId()!.toString(),
              class_name: selectedClassName(),
              dataset_id: dataset.dataset_id.toString(),
              date: sanitizedDate,
              source_name: sourceName,
              timezone: dataset.timezone ?? 'Europe/Madrid',
              batch: true,
              verbose: false,
              ...(status.script_name === '3_execute.py' ? { start_time: null, end_time: null } : {})
            };

        const payload = {
          project_id: selectedProjectId()!.toString(),
          class_name: selectedClassName(),
          script_name: status.script_name,
          parameters: parameters,
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, 300000); // 5 minute timeout (allows time for server to start process and return process_id)

        let response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
        clearTimeout(timeoutId);

        // Check for request cancellation (timeout or abort)
        if (response_json?.type === 'AbortError' || response_json?.message === 'Request cancelled') {
          throw new Error(`Request timeout for ${status.script_name} on dataset ${status.dataset_id} - script may still be running`);
        }

        // Check if server returned "process already running" status
        // For AdminScriptExecution, we wait for the process to complete instead of canceling
        // This allows concurrent execution without interruption
        if (response_json?.data?.process_already_running) {
          const runningProcesses = response_json.data.running_processes || [];
          const processList = runningProcesses.map((p: any) => 
            `- ${p.script_name} (${p.class_name}) - Started: ${p.started_at || 'unknown'}`
          ).join('\n');
          
          info(`[AdminScriptExecution] Process already running for dataset ${status.dataset_id}. Waiting for completion...\n${processList}`);
          
          // Update status to show we're waiting
          setExecutionStatuses(prev => prev.map(s => 
            s.dataset_id === status.dataset_id && s.script_name === status.script_name
              ? { ...s, status: "pending" as const, error: `Waiting for running process to complete...` }
              : s
          ));
          
          // Wait for running processes to complete by polling the running processes endpoint
          const maxWaitTime = 3600000; // 1 hour max wait
          const pollInterval = 5000; // Check every 5 seconds
          const startWaitTime = Date.now();
          let allProcessesCompleted = false;
          
          while (!allProcessesCompleted && (Date.now() - startWaitTime) < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            
            try {
              const runningCheck = await getData(apiEndpoints.python.running_processes);
              if (runningCheck?.success && runningCheck?.data) {
                const stillRunning = runningCheck.data.processes || [];
                const stillRunningIds = new Set(stillRunning.map((p: any) => p.process_id));
                
                // Check if any of the processes we're waiting for are still running
                const waitingForProcesses = runningProcesses.map((p: any) => p.process_id);
                allProcessesCompleted = !waitingForProcesses.some((pid: string) => stillRunningIds.has(pid));
                
                if (!allProcessesCompleted) {
                  const elapsed = Math.round((Date.now() - startWaitTime) / 1000);
                  debug(`[AdminScriptExecution] Still waiting for processes to complete... (${elapsed}s elapsed)`);
                }
              } else {
                // If we can't check, assume processes completed
                allProcessesCompleted = true;
              }
            } catch (error) {
              warn('[AdminScriptExecution] Error checking running processes:', error);
              // Continue waiting
            }
          }
          
          if (!allProcessesCompleted) {
            throw new Error(`Timeout waiting for running processes to complete for dataset ${status.dataset_id}`);
          }
          
          info(`[AdminScriptExecution] Running processes completed, retrying dataset ${status.dataset_id}...`);
          
          // Create a new AbortController for the retry request (the original one may be aborted)
          const retryController = new AbortController();
          const retryTimeoutId = setTimeout(() => {
            retryController.abort();
          }, 300000); // 5 minute timeout for retry
          
          // Retry the script execution after processes completed
          const retryResponse = await postData(apiEndpoints.python.execute_script, payload, retryController.signal);
          clearTimeout(retryTimeoutId);
          
          // Check for request cancellation on retry
          if (retryResponse?.type === 'AbortError' || retryResponse?.message === 'Request cancelled') {
            throw new Error(`Request timeout for ${status.script_name} on dataset ${status.dataset_id} (retry) - script may still be running`);
          }
          
          if (!retryResponse?.success) {
            // Check if there's still a process running (race condition)
            if (retryResponse?.data?.process_already_running) {
              throw new Error(`Process still running after wait for dataset ${status.dataset_id} - may need manual intervention`);
            } else {
              throw new Error(retryResponse?.message || 'Script execution failed after retry');
            }
          }
          // Use the retry response as the new response_json
          response_json = retryResponse;
        }

        if (!response_json?.success) {
          throw new Error(response_json?.message || 'Script execution failed');
        }

        const pid = (response_json as any).process_id || (response_json as any)?.data?.process_id;
        
        if (!pid) {
          throw new Error('No process_id returned');
        }

        // Update status with process_id
        setExecutionStatuses(prev => prev.map(s => 
          s.dataset_id === status.dataset_id && s.script_name === status.script_name
            ? { ...s, process_id: pid, status: "running" as const }
            : s
        ));

        // Start process tracking
        processStore.startProcess(pid, 'script_execution', false);

        // Wait for completion
        await waitForProcessCompletion(pid, dataset.dataset_id, status.script_name);
      }

    } catch (error: any) {
      // Handle AbortError (timeout) and request cancellation differently from other errors
      const isTimeout = error.name === 'AbortError' || 
                       error.message?.includes('timeout') || 
                       error.message?.includes('Request timeout');
      
      if (isTimeout) {
        warn(`Request timeout for ${status.script_name} on dataset ${status.dataset_id} - script may still be running`);
        setExecutionStatuses(prev => prev.map(s => 
          s.dataset_id === status.dataset_id && s.script_name === status.script_name
            ? { ...s, status: "error" as const, error: "Request timeout - script may still be running" }
            : s
        ));
        
        // Immediately check if the process is actually running (request might have timed out but process started)
        await syncStatusesWithRunningProcesses();
      } else {
        logError(`Error retrying ${status.script_name} for dataset ${status.dataset_id}:`, error);
        
        // Update status to error
        setExecutionStatuses(prev => prev.map(s => 
          s.dataset_id === status.dataset_id && s.script_name === status.script_name
            ? { ...s, status: "error" as const, error: error.message || "Execution failed" }
            : s
        ));
      }
      
      // Sync with running processes before converting to retry
      // This catches cases where the request timed out but the process is actually running
      await syncStatusesWithRunningProcesses();
      
      // Convert back to retry after error (only if not already updated to running)
      setTimeout(() => {
        setExecutionStatuses(prev => prev.map(s => 
          s.dataset_id === status.dataset_id && s.script_name === status.script_name && s.status === "error"
            ? { ...s, status: "retry" as const }
            : s
        ));
      }, 100);
    }
  };

  // Persist execution statuses whenever they change
  createEffect(() => {
    const statuses = executionStatuses();
    if (statuses.length > 0) {
      saveExecutionStatuses(statuses);
    }
  });

  // Recover state from localStorage and check with backend
  // 
  // How tracking works:
  // 1. Processes are OS-level subprocesses that continue running even if page/browser closes
  // 2. Frontend persists execution statuses to localStorage (survives page reloads)
  // 3. Backend tracks processes in memory (lost on server restart)
  // 4. On page reload: Frontend recovers from localStorage, then queries backend API
  //    to sync with actual running processes
  //
  // Note: If backend server restarts, it loses track of process_id mappings,
  // but the actual subprocesses continue running. The backend can detect running
  // processes but won't know which process_id they correspond to.
  const recoverExecutionState = async () => {
    const persistedStatuses = loadExecutionStatuses();
    
    if (persistedStatuses.length === 0) {
      debug('[AdminScriptExecution] No persisted execution statuses found');
      return;
    }

    info(`[AdminScriptExecution] Recovering ${persistedStatuses.length} execution status(es) from previous session`);
    
    // Filter to only running or pending statuses (completed ones are less relevant)
    const activeStatuses = persistedStatuses.filter(s => 
      s.status === 'running' || s.status === 'pending'
    );
    
    if (activeStatuses.length === 0) {
      debug('[AdminScriptExecution] No active processes to recover');
      // Still restore all statuses so user can see what completed
      setExecutionStatuses(persistedStatuses);
      return;
    }

    info(`[AdminScriptExecution] Found ${activeStatuses.length} potentially active process(es), checking with backend...`);

    // Check with backend API for running processes
    try {
      const response = await getData(apiEndpoints.python.running_processes);
      
      if (response.success && response.data) {
        const runningProcesses = response.data.processes || [];
        const runningProcessIds = new Set(runningProcesses.map((p: any) => p.process_id));
        
        debug(`[AdminScriptExecution] Backend reports ${runningProcesses.length} running process(es)`);
        
        // Update statuses based on backend state
        const updatedStatuses = persistedStatuses.map(status => {
          // Mark all recovered statuses
          const recoveredStatus = { ...status, recovered: true };
          
          // If this status has a process_id and it's marked as running/pending
          if (status.process_id && (status.status === 'running' || status.status === 'pending')) {
            if (runningProcessIds.has(status.process_id)) {
              // Process is still running
              info(`[AdminScriptExecution] Process ${status.process_id} is still running (dataset ${status.dataset_id}, ${status.script_name})`);
              // Restore to processStore so we can track it
              processStore.startProcess(status.process_id, 'script_execution', false);
              return { ...recoveredStatus, status: 'running' as const };
            } else {
              // Process is no longer running - check if it completed successfully
              // We can't know for sure without checking processStore or backend logs,
              // but we'll mark it as potentially completed (user can retry if needed)
              warn(`[AdminScriptExecution] Process ${status.process_id} is no longer running (dataset ${status.dataset_id}, ${status.script_name}) - marking as unknown`);
              return { ...recoveredStatus, status: 'error' as const, error: 'Process status unknown after page reload - check server logs or retry' };
            }
          }
          return recoveredStatus;
        });
        
        setExecutionStatuses(updatedStatuses);
        saveExecutionStatuses(updatedStatuses);
        
        // Also restore any running processes to processStore
        for (const proc of runningProcesses) {
          if (proc.process_id) {
            processStore.startProcess(proc.process_id, 'script_execution', false);
            debug(`[AdminScriptExecution] Restored process ${proc.process_id} to processStore`);
          }
        }
        
        info(`[AdminScriptExecution] State recovery complete. ${runningProcesses.length} process(es) still running.`);
      } else {
        // Backend check failed, but still restore persisted statuses
        warn('[AdminScriptExecution] Failed to check running processes with backend, restoring persisted statuses anyway');
        setExecutionStatuses(persistedStatuses);
      }
    } catch (error) {
      warn('[AdminScriptExecution] Error checking running processes:', error);
      // Still restore persisted statuses even if backend check fails
      setExecutionStatuses(persistedStatuses);
    }
  };

  // Set up periodic polling for running processes
  let pollInterval: NodeJS.Timeout | null = null;
  
  // Effect: Fetch sources when project and class_name are available
  onMount(async () => {
    await fetchProjects();
    // Recover execution state after projects are loaded
    await recoverExecutionState();
    // Check for running processes immediately and sync statuses
    await checkRunningProcesses();
    
    // Set up periodic polling for running processes (every 5 seconds)
    pollInterval = setInterval(async () => {
      await checkRunningProcesses();
    }, 5000);
  });
  
  // Cleanup polling on unmount
  onCleanup(() => {
    if (pollInterval) {
      clearInterval(pollInterval);
    }
  });

  // Watch for class_name changes to fetch sources
  createEffect(async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    if (className && projectId) {
      await fetchSources();
    }
  });

  // Filtered execution statuses for current view
  const filteredStatuses = createMemo(() => {
    return executionStatuses();
  });

  // Sync execution statuses with running processes
  // If a status is "error" or "retry" but there's a running process with matching script_name and class_name,
  // update it to "running" and track it
  const syncStatusesWithRunningProcesses = async () => {
    try {
      const response = await getData(apiEndpoints.python.running_processes);
      if (!response.success || !response.data) {
        return;
      }

      const runningProcesses = response.data.processes || [];
      const currentClassName = selectedClassName();
      
      if (runningProcesses.length === 0 || !currentClassName) {
        return;
      }

      // Update statuses that might match running processes
      setExecutionStatuses(prev => prev.map(status => {
        // Only check statuses that are error or retry (not already running)
        if (status.status !== "error" && status.status !== "retry") {
          return status;
        }

        // Find a running process that matches this script and class
        const matchingProcess = runningProcesses.find((proc: any) => 
          proc.script_name === status.script_name &&
          proc.class_name?.toLowerCase() === currentClassName.toLowerCase()
        );

        if (matchingProcess) {
          // Found a matching running process - update status to running
          debug(`[AdminScriptExecution] Found running process ${matchingProcess.process_id} for ${status.script_name} (dataset ${status.dataset_id}), updating status from ${status.status} to running`);
          
          // Start tracking this process
          processStore.startProcess(matchingProcess.process_id, 'script_execution', false);
          
          // Wait for this process to complete in the background
          // (don't await - let it run asynchronously)
          waitForProcessCompletion(matchingProcess.process_id, status.dataset_id, status.script_name).catch((error) => {
            warn(`[AdminScriptExecution] Error waiting for discovered process ${matchingProcess.process_id}:`, error);
          });
          
          return {
            ...status,
            status: "running" as const,
            process_id: matchingProcess.process_id,
            error: undefined
          };
        }

        return status;
      }));
    } catch (error: any) {
      debug('[AdminScriptExecution] Error syncing statuses with running processes:', error);
    }
  };

  // Check running processes from API
  const checkRunningProcesses = async () => {
    try {
      const response = await getData(apiEndpoints.python.running_processes);
      if (response.success && response.data) {
        const processes = response.data.processes || [];
        setRunningProcessesFromAPI(processes);
        
        // Sync statuses with running processes
        await syncStatusesWithRunningProcesses();
        
        return processes.length > 0;
      }
      setRunningProcessesFromAPI([]);
      return false;
    } catch (error: any) {
      debug('[AdminScriptExecution] Error checking running processes:', error);
      return false;
    }
  };

  // Check if there are any running scripts
  // Check executionStatuses, processStore, and API for comprehensive tracking
  const hasRunningScripts = createMemo(() => {
    // Check execution statuses
    const statuses = executionStatuses();
    const hasRunningStatus = statuses.some(status => status.status === "running" || status.status === "pending");
    
    // Check processStore for any running script execution processes
    const allProcesses = processStore.getAllProcesses();
    const hasRunningProcess = allProcesses.some(proc => 
      proc.type === 'script_execution' && proc.status === 'running'
    );
    
    // Check API for running processes (catches scripts started from other pages)
    const apiProcesses = runningProcessesFromAPI();
    const hasRunningFromAPI = apiProcesses.length > 0;
    
    return hasRunningStatus || hasRunningProcess || hasRunningFromAPI;
  });

  return (
    <div class="admin-script-execution">
      <style>{`
        .sources-grid {
          display: grid;
          grid-template-columns: repeat(1, 1fr);
          gap: 12px;
        }
        @media (min-width: 640px) {
          .sources-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
        @media (min-width: 768px) {
          .sources-grid {
            grid-template-columns: repeat(3, 1fr);
          }
        }
        @media (min-width: 1024px) {
          .sources-grid {
            grid-template-columns: repeat(4, 1fr);
          }
        }
        .sources-header-label {
          display: block;
          font-size: 14px;
          font-weight: 500;
          color: var(--color-text-primary);
        }
      `}</style>
      <div class="admin-page-header">
        <h1>Script Execution</h1>
        <p>Execute scripts for selected datasets</p>
      </div>
      
      <div class="space-y-6">
        {/* Project Selection */}
        <div class="filter-controls mt-2" style={{ "background-color": "var(--color-bg-secondary)", "transition": "background-color 0.3s ease", "width": "98%" }}>
          <label class="block text-sm font-medium text-gray-700 mb-1">Project</label>
          <select
            class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={selectedProjectId() || ""}
            onChange={(e) => {
              const projectId = Number((e.target as HTMLSelectElement).value);
              handleProjectChange(projectId);
            }}
          >
            <option value="">Select a project</option>
            <For each={projects()}>
              {(project) => (
                <option value={project.project_id}>
                  {project.description || project.project_name || `Project ${project.project_id}`}
                </option>
              )}
            </For>
          </select>
        </div>

        {/* Source Selection */}
        <Show when={selectedProjectId() && sources().length > 0}>
          <div class="filter-controls mt-2" style={{ "background-color": "var(--color-bg-secondary)", "transition": "background-color 0.3s ease", "width": "98%" }}>
            <div class="flex items-center justify-between mb-3">
              <label class="sources-header-label">
                Data Sources ({selectedSourceIds().size} of {sources().length} selected)
              </label>
              <button
                type="button"
                onClick={toggleAllSources}
                class="px-3 py-1.5 text-sm font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 hover:border-blue-300 transition-colors"
              >
                {areAllSourcesSelected() ? "Deselect All" : "Select All"}
              </button>
            </div>
            <div 
              class="sources-container"
              style={{ 
                "max-height": "300px",
                "overflow-y": "auto",
                "padding": "12px",
                "border": "1px solid var(--color-border-primary)",
                "border-radius": "6px",
                "background-color": "var(--color-bg-card)"
              }}
            >
              <div class="sources-grid">
                <For each={sources()}>
                  {(source) => (
                    <label class="source-checkbox-label">
                      <input
                        type="checkbox"
                        checked={selectedSourceIds().has(source.source_id)}
                        onChange={() => toggleSource(source.source_id)}
                        class="source-checkbox"
                      />
                      <span class="source-label-text" title={source.source_name}>
                        {source.source_name}
                      </span>
                    </label>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Show>

        {/* Date Range Selection */}
        <div class="filter-controls mt-2" style={{ "background-color": "var(--color-bg-secondary)", "transition": "background-color 0.3s ease", "width": "98%" }}>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
              <input
                type="date"
                class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={startDate()}
                onInput={(e) => setStartDate((e.target as HTMLInputElement).value)}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">End Date</label>
              <input
                type="date"
                class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={endDate()}
                onInput={(e) => setEndDate((e.target as HTMLInputElement).value)}
              />
            </div>
          </div>
          <div class="mt-4 flex items-center justify-between">
            <button
              class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              onClick={fetchDatasets}
              disabled={loading() || !selectedProjectId() || selectedSourceIds().size === 0 || !startDate() || !endDate()}
            >
              {loading() ? "Loading..." : "Fetch Datasets"}
            </button>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeInvisible()}
                onChange={(e) => setIncludeInvisible((e.target as HTMLInputElement).checked)}
                class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <span class="text-sm text-white">Run scripts only on invisible datasets</span>
            </label>
          </div>
          <Show when={datasets().length > 0}>
            <p class="mt-2 text-sm text-gray-600">
              Found {datasets().length} dataset(s) in date range
              {includeInvisible() && (
                <span class="ml-2 text-orange-600">(invisible datasets only)</span>
              )}
            </p>
          </Show>
        </div>

        {/* Execution Buttons */}
        <Show when={datasets().length > 0}>
          <div class="filter-controls mt-2" style={{ "background-color": "var(--color-bg-secondary)", "transition": "background-color 0.3s ease", "width": "98%" }}>
            <label class="block text-sm font-medium text-gray-700 mb-1">Execute Scripts</label>
            <div class="flex gap-2 flex-wrap">
              <button
                class="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                onClick={() => executeScript("0_map.py")}
                disabled={executing()}
              >
                Execute 0_map
              </button>
              <button
                class="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                onClick={() => executeScript("0_race.py")}
                disabled={executing()}
              >
                Execute 0_race
              </button>
              <button
                class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                onClick={() => executeScript("0_performance.py")}
                disabled={executing()}
              >
                Execute 0_performance
              </button>
              <button
                class="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
                onClick={() => executeScript("0_maneuvers.py")}
                disabled={executing()}
              >
                Execute 0_maneuvers
              </button>
              <button
                class="px-4 py-2 bg-rose-600 text-white rounded hover:bg-rose-700 disabled:opacity-50"
                onClick={() => executeScript("1_normalization_influx.py")}
                disabled={executing()}
              >
                Execute 1_normalization
              </button>
              <button
                class="px-4 py-2 bg-fuchsia-600 text-white rounded hover:bg-fuchsia-700 disabled:opacity-50"
                onClick={() => executeScript("2_targets.py")}
                disabled={executing()}
              >
                Execute 2_targets
              </button>
              <button
                class="px-4 py-2 bg-pink-600 text-white rounded hover:bg-pink-700 disabled:opacity-50"
                onClick={() => executeScript("2_processing.py")}
                disabled={executing()}
              >
                Execute 2_processing
              </button>
              <button
                class="px-4 py-2 bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50"
                onClick={() => executeScript("3_corrections.py")}
                disabled={executing()}
              >
                Execute 3_corrections
              </button>
              <button
                class="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                onClick={() => executeScript("2_process_and_execute.py")}
                disabled={executing()}
              >
                Execute 2_process_and_execute
              </button>
              <button
                class="px-4 py-2 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
                onClick={() => executeScript("3_execute.py")}
                disabled={executing()}
              >
                Execute 3_execute
              </button>
              <button
                class="px-4 py-2 bg-teal-600 text-white rounded hover:bg-teal-700 disabled:opacity-50"
                onClick={updateDescriptions}
                disabled={executing()}
              >
                Update Descriptions
              </button>
              <button
                class="px-4 py-2 bg-cyan-600 text-white rounded hover:bg-cyan-700 disabled:opacity-50"
                onClick={updateReportNames}
                disabled={executing()}
              >
                Update Report Names
              </button>
              <button
                class="px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                onClick={updateChannels}
                disabled={executing() || updatingChannels() || datasets().length === 0 || selectedClassName() !== 'gp50'}
                title={selectedClassName() !== 'gp50' ? 'Channel update is only supported for gp50' : 'Populate Postgres channels table for the fetched datasets (force refresh)'}
              >
                {updatingChannels() ? 'Updating channels...' : 'Update channels'}
              </button>
              <label class="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  class="rounded border-gray-300"
                  checked={cleanupPagesOnly()}
                  onChange={(e) => setCleanupPagesOnly(e.currentTarget.checked)}
                />
                <span>Day pages only</span>
              </label>
              <button
                class="px-4 py-2 bg-violet-600 text-white rounded hover:bg-violet-700 disabled:opacity-50"
                onClick={runCleanup}
                disabled={executing() || updatingCleanup() || datasets().length === 0 || selectedClassName() !== 'gp50'}
                title={
                  selectedClassName() !== 'gp50'
                    ? 'Cleanup is only supported for gp50'
                    : cleanupPagesOnly()
                      ? 'Run 4_cleanup.py with pages_only: refresh dataset_pages and day_pages from events/channels only (no VMG, race position, grade-by-VMG)'
                      : 'Run 4_cleanup.py (day-level VMG + race position + day page sync) for each unique date in the fetched datasets'
                }
              >
                {updatingCleanup() ? 'Running cleanup...' : 'Run cleanup'}
              </button>
              <button
                class="px-4 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
                onClick={runMarkwind}
                disabled={executing() || updatingMarkwind() || datasets().length === 0 || selectedClassName() !== 'gp50'}
                title={selectedClassName() !== 'gp50' ? 'Markwind is only supported for gp50' : 'Run 5_markwind.py: build and post markwind from Influx MDSS for each unique date (timezone fetched per date)'}
              >
                {updatingMarkwind() ? 'Running markwind...' : 'Run markwind'}
              </button>
            </div>
            <Show when={channelUpdateMessage()}>
              <p class="mt-2 text-sm text-gray-600">{channelUpdateMessage()}</p>
            </Show>
            <Show when={cleanupMessage()}>
              <p class="mt-2 text-sm text-gray-600">{cleanupMessage()}</p>
            </Show>
            <Show when={markwindMessage()}>
              <p class="mt-2 text-sm text-gray-600">{markwindMessage()}</p>
            </Show>
            <Show when={executing()}>
              <p class="mt-2 text-sm text-blue-600">Executing scripts... Please wait.</p>
            </Show>
          </div>
        </Show>

        {/* Status Table */}
        <Show when={executionStatuses().length > 0}>
          <div class="admin-table-container mt-4">
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-lg font-semibold">Execution Status ({executionStatuses().length} total)</h3>
              <button
                class="px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 disabled:opacity-50 transition-colors"
                onClick={() => {
                  if (confirm('Clear all execution statuses? This will remove the status history but will not affect running processes.')) {
                    setExecutionStatuses([]);
                    clearExecutionStatuses();
                    info('[AdminScriptExecution] Cleared all execution statuses');
                  }
                }}
                disabled={executing()}
              >
                Clear Statuses
              </button>
            </div>
            <div class="admin-table">
              <div class="overflow-auto h-full">
                <table class="w-full border-collapse border border-gray-200 text-left">
                  <thead class="bg-gray-200 sticky top-0 z-20">
                    <tr>
                      <th class="border border-gray-300 px-4 py-2 font-semibold">Date</th>
                      <th class="border border-gray-300 px-4 py-2 font-semibold">Source</th>
                      <th class="border border-gray-300 px-4 py-2 font-semibold">Script</th>
                      <th class="border border-gray-300 px-4 py-2 font-semibold">Status</th>
                      <th class="border border-gray-300 px-4 py-2 font-semibold">Error</th>
                      <th class="border border-gray-300 px-4 py-2 font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody class="bg-white" style={{ "background-color": "var(--color-bg-card)" }}>
                    <For each={filteredStatuses()}>
                      {(status) => (
                        <tr class={`border border-gray-200 hover:bg-gray-50 ${status.recovered ? 'bg-blue-50' : ''}`} style={{ "background-color": status.recovered ? "var(--color-bg-secondary)" : "var(--color-bg-card)" }}>
                          <td class="px-4 py-2 text-sm text-gray-600">
                            {status.date}
                            {status.recovered && <span class="ml-2 text-xs text-blue-600" title="Recovered from previous session">↩</span>}
                          </td>
                          <td class="px-4 py-2 text-sm text-gray-600">{status.source_name}</td>
                          <td class="px-4 py-2 text-sm text-gray-600">{status.script_name}</td>
                          <td class="px-4 py-2">
                            <span class={`px-2 py-1 rounded text-xs ${
                              status.status === "success" ? "bg-green-100 text-green-800" :
                              status.status === "error" ? "bg-red-100 text-red-800" :
                              status.status === "running" ? "bg-blue-100 text-blue-800" :
                              status.status === "retry" ? "bg-yellow-100 text-yellow-800" :
                              status.status === "canceled" ? "bg-orange-100 text-orange-800" :
                              "bg-gray-100 text-gray-800"
                            }`}>
                              {status.status}
                            </span>
                          </td>
                          <td class="px-4 py-2 text-sm text-red-600">{status.error || "-"}</td>
                          <td class="px-4 py-2">
                            <Show when={status.status === "retry"}>
                              <button
                                class="px-3 py-1.5 text-sm font-medium text-white bg-yellow-600 rounded hover:bg-yellow-700 disabled:opacity-50 transition-colors"
                                onClick={() => retryScript(status)}
                                disabled={executing()}
                              >
                                Retry
                              </button>
                            </Show>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </Show>

        {/* Process Management - Moved to bottom */}
        <Show when={hasRunningScripts()}>
          <div class="filter-controls mt-2" style={{ "background-color": "var(--color-bg-secondary)", "transition": "background-color 0.3s ease", "width": "98%" }}>
            <label class="block text-sm font-medium text-gray-700 mb-1">Process Management</label>
            <button
              class="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              onClick={cancelAllProcesses}
              disabled={cancellingAll() || executing()}
            >
              {cancellingAll() ? "Pending Cancelation" : "Cancel All Running Scripts"}
            </button>
            <p class="mt-2 text-sm text-gray-500">
              This will cancel all currently running and queued script processes.
            </p>
          </div>
        </Show>
      </div>
    </div>
  );
}

