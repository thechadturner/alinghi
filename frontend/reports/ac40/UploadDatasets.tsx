import { createSignal, Show, For, onMount, createEffect, createMemo } from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate } from "@solidjs/router";
import { getData, postData, getCookie } from "../../utils/global";
import { authManager } from "../../utils/authManager";
import { logActivity } from "../../utils/logging";
import { error as logError, debug, warn } from "../../utils/console";

import BackButton from "../../components/buttons/BackButton";

import { persistantStore } from "../../store/persistantStore";
import { sseManager } from "../../store/sseManager";
import { processStore } from "../../store/processStore";
import { toastStore } from "../../store/toastStore";
import { sourcesStore } from "../../store/sourcesStore";
import { apiEndpoints } from "@config/env";
const { selectedClassName, selectedProjectId, setSelectedDatasetId, setSelectedDate } = persistantStore;

/** POST `upload_profile` values for raw-folder AC40 pipelines (see server_admin/middleware/upload_raw_profiles.js). */
const AC40_UPLOAD_PROFILE_TRAINING_DB = 'ac40_training_db';
const AC40_UPLOAD_PROFILE_RACE_JSONL = 'ac40_race_jsonl';
/** Reserved raw subfolder for race .jsonl (source metadata lives inside files). */
const AC40_RACE_JSONL_SOURCE = 'JSONL';

/** e.g. log_20260328_125404.db → 20260328 (YYYYMMDD between `_` and `_` or `_` and `.`) */
function extractYyyyMmDdFromUploadFileName(fileName: string): string | null {
  const m = fileName.match(/_(\d{8})(?=[_.])/);
  if (!m) return null;
  const raw = m[1];
  return isValidCalendarYyyyMmDd(raw) ? raw : null;
}

function isValidCalendarYyyyMmDd(s: string): boolean {
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function formatYyyymmddAsIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** Group files by parsed `_YYYYMMDD_` segment; skips files without a parse (caller should validate first). */
function groupFilesByParsedYyyymmdd(fileList: File[]): Map<string, File[]> {
  const m = new Map<string, File[]>();
  for (const f of fileList) {
    const d = extractYyyyMmDdFromUploadFileName(f.name);
    if (!d) continue;
    const arr = m.get(d) ?? [];
    arr.push(f);
    m.set(d, arr);
  }
  return m;
}

type UploadDatasetEnsureMode = 'training' | 'race';

/** Idempotent: POST /api/datasets — creates or returns existing row for (source_id, date). */
async function ensureDatasetRowForUploadDate(opts: {
  sourceName: string;
  yyyymmdd: string;
  timezone: string;
  className: string;
  projectId: number;
  mode: UploadDatasetEnsureMode;
}): Promise<number> {
  const sourceId = sourcesStore.getSourceId(opts.sourceName);
  if (sourceId == null) {
    throw new Error(
      `Unknown source "${opts.sourceName}" for this project. Add it in project settings or refresh the page.`
    );
  }
  const iso = formatYyyymmddAsIsoDate(opts.yyyymmdd);
  const yearName = parseInt(opts.yyyymmdd.slice(0, 4), 10);
  if (!Number.isFinite(yearName) || yearName < 1970 || yearName > 2100) {
    throw new Error(`Invalid year in session date: ${opts.yyyymmdd}`);
  }
  const eventName = opts.mode === 'training' ? 'Training' : 'Race';
  const reportName = opts.mode === 'training' ? `Training ${iso}` : `Race ${iso}`;
  const description =
    opts.mode === 'training' ? 'Raw upload training db' : 'Raw upload JSONL';
  const body = {
    class_name: opts.className.toLowerCase(),
    project_id: opts.projectId,
    source_id: sourceId,
    date: iso,
    year_name: yearName,
    event_name: eventName,
    report_name: reportName,
    description,
    tags: JSON.stringify({}),
    timezone: opts.timezone,
  };
  const response = await postData(apiEndpoints.app.datasets, body);
  if (!response.success || response.data === null || response.data === undefined) {
    const msg =
      typeof response.message === 'string' && response.message
        ? response.message
        : 'Failed to register dataset (POST /api/datasets)';
    logError('[UploadDatasets] ensureDatasetRowForUploadDate failed:', msg, response);
    throw new Error(msg);
  }
  const rawId = response.data as number | string;
  const datasetId = typeof rawId === 'number' ? rawId : Number(rawId);
  if (!Number.isFinite(datasetId)) {
    logError('[UploadDatasets] addDataset returned non-numeric data:', response.data);
    throw new Error('Invalid dataset id from server');
  }
  debug('[UploadDatasets] Dataset ensured:', { datasetId, iso, sourceId, mode: opts.mode });
  return datasetId;
}

type ResolvedUploadDate =
  | { status: 'no-files' }
  | { status: 'unparseable'; badFiles: string[] }
  /** Every file in the current mode has a valid date; `dates` is sorted unique YYYYMMDD (may be multiple). */
  | { status: 'ready'; dates: string[] };

export default function UploadDatasetsPage() {
  const navigate = useNavigate();
  const [files, setFiles] = createSignal<File[]>([]);
  const [timezone, setTimezone] = createSignal("Europe/Madrid");
  const [timezones, setTimezones] = createSignal<string[]>([]);
  const [showWaiting, setShowWaiting] = createSignal(false);
  const [uploadSuccess, setUploadSuccess] = createSignal(false);
  const [uploadFailed, setUploadFailed] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal("");
  const [currentStatus, setCurrentStatus] = createSignal("");
  const [folderMode, setFolderMode] = createSignal(false);
  const [uploadProgress, setUploadProgress] = createSignal({ current: 0, total: 0 });
  const [isProcessing, setIsProcessing] = createSignal(false);
  const [currentStep, setCurrentStep] = createSignal(1);
  const [isTrainingDay, setIsTrainingDay] = createSignal(false);
  /** Single source for Training Day `.db` uploads (path segment under raw/date/). */
  const [trainingSourceName, setTrainingSourceName] = createSignal("");
  const [showProcessConflictModal, setShowProcessConflictModal] = createSignal(false);
  const [runningProcessesInfo, setRunningProcessesInfo] = createSignal<{ running_count: number; processes: any[] } | null>(null);

  /**
   * Basic file validation - quick check that file appears valid.
   * Full verification happens on the server side.
   * 
   * @param file - The File object to validate
   * @returns Promise that resolves if file appears valid
   */
  const validateFileBasic = async (file: File): Promise<void> => {
    // Basic checks: file exists, has size, and is readable
    if (!file || file.size === 0) {
      throw new Error(`File ${file.name} appears to be empty or invalid`);
    }

    // Quick read test to ensure file is accessible
    try {
      const slice = file.slice(0, Math.min(1024, file.size));
      const reader = new FileReader();

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('File read timeout'));
        }, 2000);

        reader.onload = () => {
          clearTimeout(timeout);
          resolve();
        };

        reader.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('File read error'));
        };

        reader.readAsArrayBuffer(slice);
      });
    } catch (readError: unknown) {
      const errorMessage = readError instanceof Error ? readError.message : 'Unknown error';
      throw new Error(`File ${file.name} is not accessible: ${errorMessage}`);
    }
  };

  // Fetch timezones
  const fetchTimezones = async () => {
    const controller = new AbortController();
    try {
      const response = await getData(`${apiEndpoints.app.admin.timezones}?project_id=${encodeURIComponent(selectedProjectId())}`, controller.signal);
      if (response.success && response.data) {
        // Extract timezone names from the response (array of objects with 'name' property)
        const tzNames = response.data.map((tz: { name?: string } | string) => (typeof tz === 'object' && tz.name ? tz.name : tz)).sort();
        setTimezones(tzNames);
        debug('[UploadDatasets] Loaded timezones:', tzNames.length);
        // Set default timezone if available
        const defaultTz = tzNames.find((tz: string) => tz.toLowerCase() === "europe/madrid".toLowerCase());
        if (defaultTz) {
          setTimezone(defaultTz);
        }
      } else {
        logError('[UploadDatasets] Failed to fetch timezones:', response.message);
        setTimezones([]);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        logError('[UploadDatasets] Error fetching timezones:', error);
      }
      setTimezones([]);
    }
  };

  onMount(async () => {
    setFolderMode(true);
    await fetchTimezones();
  });

  // Default training upload source when store becomes ready or current selection is invalid
  createEffect(() => {
    if (!sourcesStore.isReady()) return;
    const names = sourcesStore
      .sources()
      .map((s) => s.source_name)
      .filter((n): n is string => !!n && n.trim() !== '')
      .sort((a, b) => a.localeCompare(b));
    if (names.length === 0) return;
    const cur = trainingSourceName();
    if (!cur || !names.includes(cur)) {
      setTrainingSourceName(names[0]);
    }
  });

  const handleFileChange = async (event: Event) => {
    const selectedFiles = Array.from((event.target as HTMLInputElement).files || []);
    const training = isTrainingDay();

    const allowedFiles = selectedFiles.filter((file) => {
      const fileNameLower = file.name.toLowerCase();
      return training ? fileNameLower.endsWith('.db') : fileNameLower.endsWith('.jsonl');
    });

    if (allowedFiles.length === 0) {
      debug(training ? '[UploadDatasets] No .db files selected' : '[UploadDatasets] No .jsonl files selected');
      return;
    }

    // Basic validation - full verification happens on server
    try {
      for (const file of allowedFiles) {
        await validateFileBasic(file);
      }

      setFiles([...files(), ...allowedFiles]);

      if (training) {
        await logActivity(selectedProjectId() || 0, 0, 'UploadDatasets.tsx', 'Files Selected', {
          fileCount: allowedFiles.length,
          fileNames: allowedFiles.map((f) => f.name),
          trainingDb: true,
        });
        return;
      }

      await logActivity(selectedProjectId() || 0, 0, 'UploadDatasets.tsx', 'Files Selected', {
        fileCount: allowedFiles.length,
        fileNames: allowedFiles.map((f) => f.name),
        raceJsonl: true,
      });
      return;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logError('[UploadDatasets] Error validating files:', error);
      setUploadFailed(true);
      setErrorMessage(`File validation failed: ${errorMessage}. Please ensure files are accessible.`);
      toastStore.showToast('error', 'File Validation Failed', errorMessage);
    }
  };

  const handleFolderChange = async (event: Event) => {
    const selectedFiles = Array.from((event.target as HTMLInputElement).files || []);
    const training = isTrainingDay();

    const allowedFiles = selectedFiles.filter((file) => {
      const fileNameLower = file.name.toLowerCase();
      return training ? fileNameLower.endsWith('.db') : fileNameLower.endsWith('.jsonl');
    });

    if (allowedFiles.length === 0) {
      debug(
        training
          ? '[UploadDatasets] No .db files found in selected folder'
          : '[UploadDatasets] No .jsonl files found in selected folder'
      );
      return;
    }

    // Basic validation - full verification happens on server
    try {
      for (const file of allowedFiles) {
        await validateFileBasic(file);
      }

      setFiles([...files(), ...allowedFiles]);

      if (training) {
        debug('[UploadDatasets] Training folder selected:', {
          totalFiles: selectedFiles.length,
          allowedFiles: allowedFiles.length,
          fileNames: allowedFiles.map((f) => f.name),
        });
        await logActivity(selectedProjectId() || 0, 0, 'UploadDatasets.tsx', 'Folder Selected', {
          totalFiles: selectedFiles.length,
          allowedFiles: allowedFiles.length,
          fileNames: allowedFiles.map((f) => f.name),
          trainingDb: true,
        });
        return;
      }

      debug('[UploadDatasets] Race jsonl folder selected:', {
        totalFiles: selectedFiles.length,
        allowedFiles: allowedFiles.length,
        fileNames: allowedFiles.map((f) => f.name),
      });
      await logActivity(selectedProjectId() || 0, 0, 'UploadDatasets.tsx', 'Folder Selected', {
        totalFiles: selectedFiles.length,
        allowedFiles: allowedFiles.length,
        fileNames: allowedFiles.map((f) => f.name),
        raceJsonl: true,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logError('[UploadDatasets] Error validating folder files:', error);
      setUploadFailed(true);
      setErrorMessage(`File validation failed: ${errorMessage}. Please ensure files are accessible.`);
      toastStore.showToast('error', 'File Validation Failed', errorMessage);
    }
  };

  const removeFile = async (index: number) => {
    const fileToRemove = files()[index];
    const updatedFiles = files().filter((_, i) => i !== index);
    setFiles(updatedFiles);

    if (isTrainingDay()) {
      await logActivity(selectedProjectId() || 0, 0, 'UploadDatasets.tsx', 'File Removed', {
        fileName: fileToRemove.name,
        remainingFiles: updatedFiles.length,
        trainingDb: true,
      });
      return;
    }

    await logActivity(selectedProjectId() || 0, 0, 'UploadDatasets.tsx', 'File Removed', {
      fileName: fileToRemove.name,
      remainingFiles: updatedFiles.length,
      raceJsonl: true,
    });
  };

  const resetUpload = () => {
    setUploadSuccess(false);
    setUploadFailed(false);
    setErrorMessage("");
    setFiles([]);
    setTrainingSourceName("");
    // Reset timezone to default
    const defaultTz = timezones().find(tz => tz.toLowerCase() === "europe/madrid".toLowerCase());
    if (defaultTz) {
      setTimezone(defaultTz);
    } else {
      setTimezone("Europe/Madrid");
    }
  };

  const isDbFile = (filename: string): boolean => {
    return filename.toLowerCase().endsWith('.db');
  };

  const getDbFileCount = (): number => {
    return files().filter((f) => isDbFile(f.name)).length;
  };

  const isJsonlFile = (filename: string): boolean => {
    return filename.toLowerCase().endsWith('.jsonl');
  };

  const getJsonlFileCount = (): number => {
    return files().filter((f) => isJsonlFile(f.name)).length;
  };

  const resolvedUploadDate = createMemo((): ResolvedUploadDate => {
    const list = isTrainingDay()
      ? files().filter((f) => isDbFile(f.name))
      : files().filter((f) => isJsonlFile(f.name));
    if (list.length === 0) return { status: 'no-files' };
    const dates = new Set<string>();
    const badFiles: string[] = [];
    for (const f of list) {
      const d = extractYyyyMmDdFromUploadFileName(f.name);
      if (!d) badFiles.push(f.name);
      else dates.add(d);
    }
    if (badFiles.length > 0) return { status: 'unparseable', badFiles };
    return { status: 'ready', dates: [...dates].sort() };
  });

  /** Rows for the current mode (.db or .jsonl) with parsed filename dates. */
  const uploadFileDateRows = createMemo((): { name: string; yyyymmdd: string | null }[] => {
    const list = isTrainingDay()
      ? files().filter((f) => isDbFile(f.name))
      : files().filter((f) => isJsonlFile(f.name));
    return list.map((f) => ({
      name: f.name,
      yyyymmdd: extractYyyyMmDdFromUploadFileName(f.name),
    }));
  });

  const uploadDateSummaryEntries = createMemo(() => {
    const rows = uploadFileDateRows();
    const m = new Map<string, number>();
    let unparsed = 0;
    for (const r of rows) {
      if (r.yyyymmdd) m.set(r.yyyymmdd, (m.get(r.yyyymmdd) ?? 0) + 1);
      else unparsed += 1;
    }
    const entries = [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([yyyymmdd, count]) => ({ iso: formatYyyymmddAsIsoDate(yyyymmdd), count }));
    return { entries, unparsed };
  });

  const parsedDateByFileName = createMemo(() => {
    const map = new Map<string, string | null>();
    for (const r of uploadFileDateRows()) map.set(r.name, r.yyyymmdd);
    return map;
  });

  // Helper function to check if upload button should be disabled and log missing fields
  const isUploadDisabled = (): boolean => {
    if (isTrainingDay()) {
      const missing: string[] = [];
      const r = resolvedUploadDate();
      if (r.status !== 'ready') missing.push('sessionDateFromFilenames');
      if (!timezone()) missing.push('timezone');
      if (!trainingSourceName()) missing.push('trainingSource');
      if (getDbFileCount() === 0) missing.push('.db files');

      if (missing.length > 0) {
        debug('[UploadDatasets] Upload button disabled (training .db) - missing fields:', missing);
      }

      return missing.length > 0;
    }
    const missingRace: string[] = [];
    const rRace = resolvedUploadDate();
    if (rRace.status !== 'ready') missingRace.push('sessionDateFromFilenames');
    if (!timezone()) missingRace.push('timezone');
    if (getJsonlFileCount() === 0) missingRace.push('.jsonl files');
    if (missingRace.length > 0) {
      debug('[UploadDatasets] Upload button disabled (race .jsonl) - missing fields:', missingRace);
    }
    return missingRace.length > 0;
  };

  const checkRunningProcesses = async (): Promise<{ running_count: number; processes: any[] } | null> => {
    try {
      const response = await getData(apiEndpoints.python.running_processes);
      if (response.success && response.data) {
        return response.data;
      }
      return null;
    } catch (error) {
      debug('[UploadDatasets] Error checking running processes:', error);
      return null;
    }
  };

  const cancelRunningProcess = async (processId: string): Promise<boolean> => {
    try {
      const response = await postData(apiEndpoints.python.cancel_process(processId), {});
      return response.success === true;
    } catch (error) {
      warn('[UploadDatasets] Error cancelling process:', error);
      return false;
    }
  };

  /** Runs `2_process_and_execute.py` after raw upload; waits for completion via processStore + SSE. */
  const runPostUploadProcessAndExecute = async (opts: {
    datasetId: number;
    isoDate: string;
    sourceName: string;
    labelForStatus: string;
  }): Promise<void> => {
    const projectId = selectedProjectId();
    const className = selectedClassName().toString();
    await sseManager.connectToServer(8049);
    debug('[UploadDatasets] SSE connected for post-upload pipeline', opts.labelForStatus);

    const parameters = {
      project_id: String(projectId),
      class_name: className,
      dataset_id: String(opts.datasetId),
      date: opts.isoDate,
      source_name: opts.sourceName,
      batch: true,
      verbose: true,
    };

    const payload = {
      project_id: String(projectId),
      class_name: className,
      script_name: '2_process_and_execute.py',
      parameters,
    };

    const controller = new AbortController();
    let response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);

    if (response_json?.data?.process_already_running) {
      const runningProcesses = response_json.data.running_processes || [];
      const processList = runningProcesses
        .map(
          (p: { script_name?: string; class_name?: string; started_at?: string }) =>
            `- ${p.script_name} (${p.class_name}) - Started: ${p.started_at || 'unknown'}`
        )
        .join('\n');
      const confirmed = window.confirm(
        `A process is already running:\n\n${processList}\n\nCancel it and start the post-upload pipeline for ${opts.labelForStatus}?`
      );
      if (!confirmed) {
        throw new Error('Post-upload processing was skipped because another process is running.');
      }
      for (const proc of runningProcesses) {
        const cancelled = await cancelRunningProcess(proc.process_id);
        if (!cancelled) warn('[UploadDatasets] Failed to cancel process:', proc.process_id);
      }
      await new Promise((r) => setTimeout(r, 1000));
      response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
    }

    if (!response_json?.success) {
      let errorMessage = response_json?.message || 'Unknown error';
      const errorData =
        (response_json as { errorResponse?: { data?: { error_lines?: string[] } }; data?: { error_lines?: string[] } })
          ?.errorResponse?.data || (response_json as { data?: { error_lines?: string[] } })?.data;
      if (errorData?.error_lines && Array.isArray(errorData.error_lines) && errorData.error_lines.length > 0) {
        const lastError = errorData.error_lines[errorData.error_lines.length - 1];
        if (lastError && typeof lastError === 'string' && lastError.trim()) {
          errorMessage = lastError.length > 150 ? lastError.substring(0, 150) + '...' : lastError;
        }
      }
      throw new Error(`Pipeline failed to start: ${errorMessage}`);
    }

    const pid: string | null =
      (response_json as { process_id?: string }).process_id ??
      (response_json as { data?: { process_id?: string } })?.data?.process_id ??
      null;

    if (!pid) {
      throw new Error('No process ID returned from server for post-upload pipeline');
    }

    processStore.startProcess(pid, 'script_execution');
    processStore.setShowToast(pid, false);

    const outcome = await new Promise<'complete' | 'error' | 'timeout'>((resolve) => {
      const startTime = Date.now();
      const maxTimeoutMs = 600_000;
      let settled = false;

      const tick = () => {
        if (settled) return;
        const proc = processStore.getProcess(pid);
        const elapsed = Date.now() - startTime;

        if (elapsed >= maxTimeoutMs) {
          if (proc?.status === 'running') {
            settled = true;
            resolve('timeout');
            return;
          }
        }

        if (proc) {
          if (proc.status === 'complete') {
            settled = true;
            resolve('complete');
          } else if (proc.status === 'error' || proc.status === 'timeout') {
            settled = true;
            resolve('error');
          } else {
            setTimeout(tick, 500);
          }
        } else {
          setTimeout(tick, 500);
        }
      };

      tick();
    });

    if (outcome === 'error') {
      throw new Error(`Processing pipeline failed for ${opts.labelForStatus}`);
    }
    if (outcome === 'timeout') {
      throw new Error(
        `Processing pipeline timed out for ${opts.labelForStatus}. It may still be running in the background.`
      );
    }
    debug('[UploadDatasets] Post-upload pipeline completed:', opts.labelForStatus);
  };

  const handleUpload = async () => {
    debug('[UploadDatasets] handleUpload called - checking for running processes first');

    // Check for running processes before starting upload
    const runningInfo = await checkRunningProcesses();
    if (runningInfo && runningInfo.running_count > 0) {
      // Show modal to let user choose
      setRunningProcessesInfo(runningInfo);
      setShowProcessConflictModal(true);
      return; // Exit early - the modal will call handleUploadWithProcessDecision
    }

    // No running processes, proceed with upload
    await handleUploadWithProcessDecision(false);

    // This function is called after user makes a decision about running processes
    // or directly if there are no running processes
  };

  const handleUploadWithProcessDecision = async (cancelRunning: boolean) => {
    // If user chose to cancel running processes, do that first
    if (cancelRunning && runningProcessesInfo()) {
      debug('[UploadDatasets] User chose to cancel running processes');
      const processes = runningProcessesInfo()!.processes;
      for (const proc of processes) {
        const cancelled = await cancelRunningProcess(proc.process_id);
        if (cancelled) {
          debug('[UploadDatasets] Cancelled process:', proc.process_id);
        } else {
          warn('[UploadDatasets] Failed to cancel process:', proc.process_id);
        }
      }

      // Wait a moment for processes to cancel
      await new Promise(resolve => setTimeout(resolve, 1000));
    } else if (!cancelRunning) {
      // User chose to add to queue - continue with upload (it will wait for processes)
      debug('[UploadDatasets] User chose to add to queue - continuing with upload');
    }

    // Close the conflict modal
    setShowProcessConflictModal(false);
    setRunningProcessesInfo(null);

    debug('[UploadDatasets] Starting upload - setting showWaiting to true');

    // Set status and show modal FIRST, before any async operations
    setCurrentStatus("Initializing...");
    setShowWaiting(true);
    setUploadSuccess(false);
    setUploadFailed(false);
    setErrorMessage("");

    // Force a render cycle to ensure modal is visible
    await new Promise(resolve => setTimeout(resolve, 50));
    debug('[UploadDatasets] Modal should be visible now, showWaiting:', showWaiting());

    // Log upload attempt start (don't await - let it run in background)
    logActivity(
      selectedProjectId() || 0,
      0,
      'UploadDatasets.tsx',
      'Upload Attempt Started',
      {
        fileCount: isTrainingDay() ? getDbFileCount() : getJsonlFileCount(),
        fileNames: files().map((f) => f.name),
        sourceName: isTrainingDay() ? trainingSourceName() : AC40_RACE_JSONL_SOURCE,
        className: selectedClassName(),
        trainingDb: isTrainingDay(),
        raceJsonl: !isTrainingDay(),
      }
    ).catch((err) => debug('[UploadDatasets] Error logging activity:', err));

    try {
      // Training Day: ensure dataset row per session date, upload `.db` to data/raw, then run 2_process_and_execute.py per date
      if (isTrainingDay()) {
        const rTrain = resolvedUploadDate();
        if (rTrain.status !== 'ready') {
          if (rTrain.status === 'unparseable') {
            throw new Error(
              `Could not read session date (expected _YYYYMMDD_ in each filename, e.g. log_20260328_125404.db): ${rTrain.badFiles.slice(0, 3).join(', ')}${rTrain.badFiles.length > 3 ? '…' : ''}`
            );
          }
          throw new Error('Date is required: add files whose names include the session date.');
        }
        if (!timezone()) {
          throw new Error('Timezone is required for training day upload');
        }
        const src = trainingSourceName();
        if (!src || !src.trim()) {
          throw new Error('Source is required for training day upload');
        }
        const dbFiles = files().filter((f) => isDbFile(f.name));
        if (dbFiles.length === 0) {
          throw new Error('At least one .db file is required');
        }

        const byDate = groupFilesByParsedYyyymmdd(dbFiles);
        if (byDate.size !== rTrain.dates.length || [...byDate.values()].reduce((n, a) => n + a.length, 0) !== dbFiles.length) {
          throw new Error('Internal error: file date grouping mismatch; please retry.');
        }

        const uploadAccessToken = authManager.getAccessToken();
        setCurrentStep(1);
        const totalTrain = dbFiles.length;
        setUploadProgress({ current: 0, total: totalTrain });

        let trainIdx = 0;
        for (const yyyymmdd of rTrain.dates) {
          const isoForDataset = formatYyyymmddAsIsoDate(yyyymmdd);
          setCurrentStatus(`Ensuring dataset for ${isoForDataset}…`);
          const trainingDatasetId = await ensureDatasetRowForUploadDate({
            sourceName: src,
            yyyymmdd,
            timezone: timezone(),
            className: selectedClassName(),
            projectId: selectedProjectId(),
            mode: 'training',
          });
          const group = byDate.get(yyyymmdd) ?? [];
          for (const file of group) {
            trainIdx += 1;
            setUploadProgress({ current: trainIdx, total: totalTrain });
            setCurrentStatus(
              `Uploading ${trainIdx} of ${totalTrain} (${formatYyyymmddAsIsoDate(yyyymmdd)}): ${file.name}...`
            );

            const formData = new FormData();
            formData.append('files', file);
            formData.append('class_name', selectedClassName().toLowerCase());
            formData.append('project_id', selectedProjectId().toString());
            formData.append('source_name', src);
            formData.append('skip_normalization', 'true');
            formData.append('upload_date', yyyymmdd);
            formData.append('timezone', timezone());
            formData.append('upload_profile', AC40_UPLOAD_PROFILE_TRAINING_DB);

            const response = await fetch(`${apiEndpoints.admin.upload}/data`, {
              method: 'POST',
              credentials: 'include',
              headers: {
                Authorization: `Bearer ${uploadAccessToken}`,
                'X-CSRF-Token': getCookie('csrf_token') || '',
              },
              body: formData,
            });

            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(`Upload failed for ${file.name}: ${errorText}`);
            }

            const uploadResponse = (await response.json()) as { success?: boolean; message?: string };
            if (!uploadResponse.success) {
              throw new Error(uploadResponse.message || `Upload failed for ${file.name}`);
            }
            debug('[UploadDatasets] Training .db uploaded:', file.name, yyyymmdd);
          }

          setCurrentStatus(`Running processing pipeline for ${isoForDataset}…`);
          await runPostUploadProcessAndExecute({
            datasetId: trainingDatasetId,
            isoDate: isoForDataset,
            sourceName: src,
            labelForStatus: isoForDataset,
          });
        }

        setCurrentStatus('Upload and processing pipeline finished.');
        const trainDateLabel =
          rTrain.dates.length === 1
            ? formatYyyymmddAsIsoDate(rTrain.dates[0])
            : rTrain.dates.map(formatYyyymmddAsIsoDate).join(', ');
        toastStore.showToast(
          'success',
          'Upload complete',
          `${dbFiles.length} file(s) saved under data/raw; 2_process_and_execute completed for session date(s) ${trainDateLabel}.`
        );
        setUploadSuccess(true);
        setShowWaiting(false);
        return;
      }

      // Race Day: upload .jsonl to data/raw, then run 2_process_and_execute.py per session date
      const rRaceUpload = resolvedUploadDate();
      if (rRaceUpload.status !== 'ready') {
        if (rRaceUpload.status === 'unparseable') {
          throw new Error(
            `Could not read session date (expected _YYYYMMDD_ in each filename): ${rRaceUpload.badFiles.slice(0, 3).join(', ')}${rRaceUpload.badFiles.length > 3 ? '…' : ''}`
          );
        }
        throw new Error('Date is required: add files whose names include the session date.');
      }
      if (!timezone()) {
        throw new Error('Timezone is required for race day upload');
      }
      const jsonlFiles = files().filter((f) => isJsonlFile(f.name));
      if (jsonlFiles.length === 0) {
        throw new Error('At least one .jsonl file is required');
      }

      const byDateRace = groupFilesByParsedYyyymmdd(jsonlFiles);
      if (byDateRace.size !== rRaceUpload.dates.length || [...byDateRace.values()].reduce((n, a) => n + a.length, 0) !== jsonlFiles.length) {
        throw new Error('Internal error: file date grouping mismatch; please retry.');
      }

      const uploadAccessTokenRace = authManager.getAccessToken();
      setCurrentStep(1);
      const totalRace = jsonlFiles.length;
      setUploadProgress({ current: 0, total: totalRace });

      let raceIdx = 0;
      for (const yyyymmdd of rRaceUpload.dates) {
        const isoForDatasetRace = formatYyyymmddAsIsoDate(yyyymmdd);
        setCurrentStatus(`Ensuring dataset for ${isoForDatasetRace}…`);
        const raceDatasetId = await ensureDatasetRowForUploadDate({
          sourceName: AC40_RACE_JSONL_SOURCE,
          yyyymmdd,
          timezone: timezone(),
          className: selectedClassName(),
          projectId: selectedProjectId(),
          mode: 'race',
        });
        const group = byDateRace.get(yyyymmdd) ?? [];
        for (const file of group) {
          raceIdx += 1;
          setUploadProgress({ current: raceIdx, total: totalRace });
          setCurrentStatus(
            `Uploading ${raceIdx} of ${totalRace} (${formatYyyymmddAsIsoDate(yyyymmdd)}): ${file.name}...`
          );

          const formDataRace = new FormData();
          formDataRace.append('files', file);
          formDataRace.append('class_name', selectedClassName().toLowerCase());
          formDataRace.append('project_id', selectedProjectId().toString());
          formDataRace.append('source_name', AC40_RACE_JSONL_SOURCE);
          formDataRace.append('skip_normalization', 'true');
          formDataRace.append('upload_date', yyyymmdd);
          formDataRace.append('timezone', timezone());
          formDataRace.append('upload_profile', AC40_UPLOAD_PROFILE_RACE_JSONL);

          const responseRace = await fetch(`${apiEndpoints.admin.upload}/data`, {
            method: 'POST',
            credentials: 'include',
            headers: {
              Authorization: `Bearer ${uploadAccessTokenRace}`,
              'X-CSRF-Token': getCookie('csrf_token') || '',
            },
            body: formDataRace,
          });

          if (!responseRace.ok) {
            const errorTextRace = await responseRace.text();
            throw new Error(`Upload failed for ${file.name}: ${errorTextRace}`);
          }

          const uploadResponseRace = (await responseRace.json()) as { success?: boolean; message?: string };
          if (!uploadResponseRace.success) {
            throw new Error(uploadResponseRace.message || `Upload failed for ${file.name}`);
          }
          debug('[UploadDatasets] Race .jsonl uploaded:', file.name, yyyymmdd);
        }

        setCurrentStatus(`Running processing pipeline for ${isoForDatasetRace}…`);
        await runPostUploadProcessAndExecute({
          datasetId: raceDatasetId,
          isoDate: isoForDatasetRace,
          sourceName: AC40_RACE_JSONL_SOURCE,
          labelForStatus: isoForDatasetRace,
        });
      }

      setCurrentStatus('Upload and processing pipeline finished.');
      const raceDateLabel =
        rRaceUpload.dates.length === 1
          ? formatYyyymmddAsIsoDate(rRaceUpload.dates[0])
          : rRaceUpload.dates.map(formatYyyymmddAsIsoDate).join(', ');
      toastStore.showToast(
        'success',
        'Upload complete',
        `${jsonlFiles.length} file(s) saved under data/raw; 2_process_and_execute completed for session date(s) ${raceDateLabel} (JSONL).`
      );
      setUploadSuccess(true);
      setShowWaiting(false);
    } catch (error: unknown) {
      logError('Error uploading files:', error);
      setShowWaiting(false);
      setUploadFailed(true);
      const msg = error instanceof Error ? error.message : 'Unknown error';
      setErrorMessage(`Upload error: ${msg}`);
      // Stay on UploadDatasets page - don't navigate on error
      // Files are preserved so user can retry
    }
  };

  const handleStopProcessing = async () => {
    debug('[UploadDatasets] handleStopProcessing called');

    try {
      setCurrentStatus("Stopping processing...");

      const processIds: string[] = [];
      debug('[UploadDatasets] Cancelling processes:', processIds);

      for (const pid of processIds) {
        try {
          const response = await postData(
            `${apiEndpoints.python.execute_script.replace('/execute_script/', '')}/api/scripts/cancel/${pid}`,
            {}
          );

          if (response.success) {
            debug(`[UploadDatasets] Successfully cancelled process ${pid}`);
          } else {
            warn(`[UploadDatasets] Failed to cancel process ${pid}:`, response.message);
          }
        } catch (error) {
          warn(`[UploadDatasets] Error cancelling process ${pid}:`, error);
        }
      }

      // Clean up batch suppression mode
      processStore.clearSuppressedProcessIds();
      processStore.disableBatchSuppressMode();

      // Close modal and navigate
      setShowWaiting(false);
      setIsProcessing(false);
      navigate('/dashboard');

    } catch (error) {
      logError('[UploadDatasets] Error in handleStopProcessing:', error);
      // Still navigate away even if cancellation had errors
      setShowWaiting(false);
      setIsProcessing(false);
      navigate('/dashboard');
    }
  };

  // Handle exiting while processing continues
  const handleExit = () => {
    debug('[UploadDatasets] handleExit called - processing will continue in background');

    // Just close modal and navigate - processing continues
    setShowWaiting(false);
    setIsProcessing(false);
    navigate('/dashboard');
  };

  // Determine step title based on current step
  const getStepTitle = () => {
    return currentStep() === 1 ? 'Uploading to data/raw' : 'Working…';
  };

  return (
    <>
      <div class="login-page">
        <div class="login-page-scroll-container">
          <div class="login-container" style="max-width: 800px;">
            <Show when={showWaiting()}>
              {/* Upload Progress View */}
              <div class="login-header">
                <div class="logo-section">
                  <div class="logo-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="animation: spin 1s linear infinite;">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="31.416" stroke-dashoffset="15.708" opacity="0.3" />
                      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="31.416" stroke-dashoffset="15.708">
                        <animateTransform attributeName="transform" type="rotate" dur="1s" repeatCount="indefinite" values="0 12 12;360 12 12" />
                      </circle>
                    </svg>
                  </div>
                  <h1 class="login-title">{getStepTitle()}</h1>
                  <p class="login-subtitle" style="min-height: 24px;">{currentStatus() || "Processing your data files..."}</p>
                </div>
              </div>
              <div style="text-align: center; padding: 20px;">
                <Show when={uploadProgress().total > 0}>
                  <div style="margin-bottom: 20px;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; color: var(--color-text-secondary);">
                      <span>File {uploadProgress().current} of {uploadProgress().total}</span>
                      <span>{Math.round((uploadProgress().current / uploadProgress().total) * 100)}%</span>
                    </div>
                    <div style="width: 100%; height: 8px; background: var(--color-bg-secondary, #e5e7eb); border-radius: 4px; overflow: hidden;">
                      <div style={`width: ${(uploadProgress().current / uploadProgress().total) * 100}%; height: 100%; background: linear-gradient(90deg, #3b82f6 0%, #2563eb 100%); transition: width 0.3s ease; border-radius: 4px;`}></div>
                    </div>
                  </div>
                </Show>
                <Show when={isProcessing()}>
                  <div style="color: var(--color-text-secondary); font-size: 14px; margin-top: 20px;">
                    Processing will continue in the background. If you wish to exit this page, you will be notified when the processing is completed.
                  </div>
                </Show>
                <Show when={isProcessing()}>
                  <div style="display: flex; gap: 12px; justify-content: center; margin-top: 20px;">
                    <button
                      onClick={async () => {
                        const confirmed = window.confirm(
                          "Are you sure you want to stop all processing? This will cancel all running scripts and may leave datasets in an incomplete state. This action cannot be undone."
                        );
                        if (confirmed) {
                          await handleStopProcessing();
                        }
                      }}
                      style="padding: 10px 24px; background: #dc2626; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: background 0.2s;"
                      onMouseOver={(e) => e.currentTarget.style.background = '#b91c1c'}
                      onMouseOut={(e) => e.currentTarget.style.background = '#dc2626'}
                    >
                      Stop Processing
                    </button>
                    <button
                      onClick={async () => {
                        const confirmed = window.confirm(
                          "Are you sure you want to exit? Processing will continue in the background. You can check progress later."
                        );
                        if (confirmed) {
                          handleExit();
                        }
                      }}
                      style="padding: 10px 24px; background: var(--color-bg-button, #6b7280); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: background 0.2s;"
                      onMouseOver={(e) => e.currentTarget.style.background = '#4b5563'}
                      onMouseOut={(e) => e.currentTarget.style.background = 'var(--color-bg-button, #6b7280)'}
                    >
                      Exit
                    </button>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={!showWaiting() && !uploadSuccess() && !uploadFailed()}>
              <div class="login-header">
                <div class="logo-section">
                  <div class="logo-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                      <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                      <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                      <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                      <polyline points="10,9 9,9 8,9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </div>
                  <h1 class="login-title">Upload Datasets</h1>
                  <p class="login-subtitle">Upload your data files to start analyzing</p>
                </div>
              </div>

              <form class="login-form" onSubmit={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleUpload();
              }}>
                {/* Day Type Toggle */}
                <div class="form-group">
                  <label class="form-label">Day Type</label>
                  <div style="display: flex; gap: 12px; align-items: center;">
                    <button
                      type="button"
                      onClick={() => {
                        setIsTrainingDay(false);
                        setFiles([]);
                        setTrainingSourceName('');
                      }}
                      style={`padding: 10px 24px; border: 2px solid ${!isTrainingDay() ? '#3b82f6' : '#e5e7eb'}; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; background: ${!isTrainingDay() ? '#3b82f6' : 'transparent'}; color: ${!isTrainingDay() ? 'white' : 'var(--color-text-primary)'};`}
                      onMouseOver={(e) => {
                        if (isTrainingDay()) {
                          e.currentTarget.style.borderColor = '#3b82f6';
                          e.currentTarget.style.color = '#3b82f6';
                        }
                      }}
                      onMouseOut={(e) => {
                        if (isTrainingDay()) {
                          e.currentTarget.style.borderColor = '#e5e7eb';
                          e.currentTarget.style.color = 'var(--color-text-primary)';
                        }
                      }}
                    >
                      Race Day
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsTrainingDay(true);
                        setFiles([]);
                        setTrainingSourceName('');
                      }}
                      style={`padding: 10px 24px; border: 2px solid ${isTrainingDay() ? '#3b82f6' : '#e5e7eb'}; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; background: ${isTrainingDay() ? '#3b82f6' : 'transparent'}; color: ${isTrainingDay() ? 'white' : 'var(--color-text-primary)'};`}
                      onMouseOver={(e) => {
                        if (!isTrainingDay()) {
                          e.currentTarget.style.borderColor = '#3b82f6';
                          e.currentTarget.style.color = '#3b82f6';
                        }
                      }}
                      onMouseOut={(e) => {
                        if (!isTrainingDay()) {
                          e.currentTarget.style.borderColor = '#e5e7eb';
                          e.currentTarget.style.color = 'var(--color-text-primary)';
                        }
                      }}
                    >
                      Training Day
                    </button>
                  </div>
                </div>

                {/* Training Day: single source for data/raw path */}
                <Show when={isTrainingDay() && sourcesStore.isReady() && sourcesStore.sources().length > 0}>
                  <div class="form-group">
                    <label for="trainingSourceSelect" class="form-label">Source</label>
                    <div class="input-container">
                      <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" />
                        <path d="M12 6v6l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                      </svg>
                      <select
                        id="trainingSourceSelect"
                        value={trainingSourceName()}
                        onInput={(e) => setTrainingSourceName((e.target as HTMLSelectElement).value)}
                        class="form-input"
                      >
                        <option value="">-- Select Source --</option>
                        <For
                          each={sourcesStore
                            .sources()
                            .filter((s) => s.source_name && s.source_name.trim() !== '')
                            .sort((a, b) => (a.source_name || '').localeCompare(b.source_name || ''))}
                        >
                          {(source) => <option value={source.source_name || ''}>{source.source_name}</option>}
                        </For>
                      </select>
                    </div>
                  </div>
                </Show>

                <div class="form-group">
                  <label for="timezone" class="form-label">Timezone</label>
                  <div class="input-container">
                    <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" />
                      <polyline points="12,6 12,12 16,14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    <select
                      id="timezone"
                      value={timezone()}
                      onInput={(e) => {
                        const newTimezone = (e.target as HTMLSelectElement).value;
                        debug('[UploadDatasets] Timezone changed:', { old: timezone(), new: newTimezone });
                        setTimezone(newTimezone);
                      }}
                      class="form-input"
                    >
                      <option value="">-- Select Timezone --</option>
                      <For each={timezones()}>
                        {(tz) => (
                          <option value={tz}>{tz}</option>
                        )}
                      </For>
                    </select>
                  </div>
                </div>

                {/* Race Day: .jsonl files */}
                <Show when={!isTrainingDay() && files().length === 0}>
                  <div class="form-group">
                    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                      <input
                        type="checkbox"
                        id="folderModeRace"
                        checked={folderMode()}
                        onChange={(e) => {
                          setFolderMode(e.target.checked);
                          setFiles([]);
                        }}
                        style="width: 18px; height: 18px; cursor: pointer;"
                      />
                      <label for="folderModeRace" style="cursor: pointer; color: var(--color-text-primary); font-size: 14px;">
                        Select folder (finds all .jsonl files)
                      </label>
                    </div>
                    <label for={folderMode() ? 'raceJsonlFolderInput' : 'raceJsonlFileInput'} class="form-label">
                      {folderMode() ? 'Select Folder' : 'Select Files'}
                    </label>
                    <Show when={!folderMode()}>
                      <div class="file-upload-container">
                        <input
                          id="raceJsonlFileInput"
                          type="file"
                          multiple
                          onChange={handleFileChange}
                          class="file-input"
                          accept=".jsonl,application/jsonl+json,application/x-ndjson"
                        />
                        <label for="raceJsonlFileInput" class="file-upload-label">
                          <svg class="file-upload-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            <polyline points="7,10 12,15 17,10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                          </svg>
                          <span class="file-upload-text">Choose .jsonl files</span>
                          <span class="file-upload-subtext">JSON Lines (source inside each line)</span>
                        </label>
                      </div>
                    </Show>
                    <Show when={folderMode()}>
                      <div class="file-upload-container">
                        <input
                          id="raceJsonlFolderInput"
                          type="file"
                          multiple
                          onChange={handleFolderChange}
                          class="file-input"
                          {...({ webkitdirectory: true, directory: true } as Record<string, unknown>)}
                        />
                        <label for="raceJsonlFolderInput" class="file-upload-label">
                          <svg class="file-upload-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M3 7V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H9.586C9.85119 3 10.1055 3.10536 10.293 3.29289L12.707 5.70711C12.8945 5.89464 13.1488 6 13.414 6H19C19.5304 6 20.0391 6.21071 20.4142 6.58579C20.7893 6.96086 21 7.46957 21 8V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            <path d="M7 13H17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            <path d="M7 17H13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                          </svg>
                          <span class="file-upload-text">Choose folder</span>
                          <span class="file-upload-subtext">All .jsonl files in the folder will be selected</span>
                        </label>
                      </div>
                    </Show>
                  </div>
                </Show>

                <Show when={!isTrainingDay() && files().length > 0}>
                  <div class="files-list">
                    <h3 class="files-list-title">Selected Files ({getJsonlFileCount()})</h3>
                    <Show when={getJsonlFileCount() > 0}>
                      <ul class="upload-files-dates-summary">
                        <For each={uploadDateSummaryEntries().entries}>
                          {(e) => (
                            <li>
                              {e.iso} ({e.count} {e.count === 1 ? 'file' : 'files'})
                            </li>
                          )}
                        </For>
                        <Show when={uploadDateSummaryEntries().unparsed > 0}>
                          <li class="upload-files-dates-summary-unparsed">
                            No date in filename: {uploadDateSummaryEntries().unparsed}{' '}
                            {uploadDateSummaryEntries().unparsed === 1 ? 'file' : 'files'}
                          </li>
                        </Show>
                      </ul>
                    </Show>
                    <div class="files-table">
                      {files().map((file, index) => {
                        const d = parsedDateByFileName().get(file.name) ?? null;
                        return (
                          <div class="file-item" data-key={index}>
                            <div class="file-info">
                              <svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                              </svg>
                              <span class="file-name">{file.name}</span>
                              <span class="file-size">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                            </div>
                            <span
                              class={`upload-file-parsed-date${d ? '' : ' upload-file-parsed-date--missing'}`}
                            >
                              {d ? formatYyyymmddAsIsoDate(d) : '—'}
                            </span>
                            <button type="button" onClick={() => removeFile(index)} class="remove-file-btn">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                              </svg>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </Show>

                {/* Training Day: SQLite .db → data/raw */}
                <Show when={isTrainingDay() && files().length === 0}>
                  <div class="form-group">
                    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                      <input
                        type="checkbox"
                        id="folderModeTraining"
                        checked={folderMode()}
                        onChange={(e) => {
                          setFolderMode(e.target.checked);
                          setFiles([]);
                        }}
                        style="width: 18px; height: 18px; cursor: pointer;"
                      />
                      <label for="folderModeTraining" style="cursor: pointer; color: var(--color-text-primary); font-size: 14px;">
                        Select folder (finds all .db files)
                      </label>
                    </div>
                    <label for={folderMode() ? 'trainingDbFolderInput' : 'trainingDbFileInput'} class="form-label">
                      {folderMode() ? 'Select Folder' : 'Select Files'}
                    </label>
                    <Show when={!folderMode()}>
                      <div class="file-upload-container">
                        <input
                          id="trainingDbFileInput"
                          type="file"
                          multiple
                          onChange={handleFileChange}
                          class="file-input"
                          accept=".db,application/octet-stream"
                        />
                        <label for="trainingDbFileInput" class="file-upload-label">
                          <svg class="file-upload-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            <polyline points="7,10 12,15 17,10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                          </svg>
                          <span class="file-upload-text">Choose .db files</span>
                          <span class="file-upload-subtext">SQLite database files only</span>
                        </label>
                      </div>
                    </Show>
                    <Show when={folderMode()}>
                      <div class="file-upload-container">
                        <input
                          id="trainingDbFolderInput"
                          type="file"
                          multiple
                          onChange={handleFolderChange}
                          class="file-input"
                          {...({ webkitdirectory: true, directory: true } as Record<string, unknown>)}
                        />
                        <label for="trainingDbFolderInput" class="file-upload-label">
                          <svg class="file-upload-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M3 7V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H9.586C9.85119 3 10.1055 3.10536 10.293 3.29289L12.707 5.70711C12.8945 5.89464 13.1488 6 13.414 6H19C19.5304 6 20.0391 6.21071 20.4142 6.58579C20.7893 6.96086 21 7.46957 21 8V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            <path d="M7 13H17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            <path d="M7 17H13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                          </svg>
                          <span class="file-upload-text">Choose folder</span>
                          <span class="file-upload-subtext">All .db files in the folder will be selected</span>
                        </label>
                      </div>
                    </Show>
                  </div>
                </Show>

                <Show when={isTrainingDay() && files().length > 0}>
                  <div class="files-list">
                    <h3 class="files-list-title">Selected Files ({getDbFileCount()})</h3>
                    <Show when={getDbFileCount() > 0}>
                      <ul class="upload-files-dates-summary">
                        <For each={uploadDateSummaryEntries().entries}>
                          {(e) => (
                            <li>
                              {e.iso} ({e.count} {e.count === 1 ? 'file' : 'files'})
                            </li>
                          )}
                        </For>
                        <Show when={uploadDateSummaryEntries().unparsed > 0}>
                          <li class="upload-files-dates-summary-unparsed">
                            No date in filename: {uploadDateSummaryEntries().unparsed}{' '}
                            {uploadDateSummaryEntries().unparsed === 1 ? 'file' : 'files'}
                          </li>
                        </Show>
                      </ul>
                    </Show>
                    <div class="files-table">
                      {files().map((file, index) => {
                        const d = parsedDateByFileName().get(file.name) ?? null;
                        return (
                          <div class="file-item" data-key={index}>
                            <div class="file-info">
                              <svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                              </svg>
                              <span class="file-name">{file.name}</span>
                              <span class="file-size">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                            </div>
                            <span
                              class={`upload-file-parsed-date${d ? '' : ' upload-file-parsed-date--missing'}`}
                            >
                              {d ? formatYyyymmddAsIsoDate(d) : '—'}
                            </span>
                            <button type="button" onClick={() => removeFile(index)} class="remove-file-btn">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                              </svg>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </Show>

                <button type="submit" class="login-button" disabled={isUploadDisabled()}>
                  <span class="button-text">Upload Files</span>
                  <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    <polyline points="7,10 12,15 17,10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </form>
            </Show>

            <Show when={uploadSuccess()}>
              <div class="login-header">
                <div class="logo-section">
                  <div class="logo-icon" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M9 12L11 14L15 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                      <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </div>
                  <h1 class="login-title">
                    <Show when={isTrainingDay()} fallback="Race JSONL uploaded">
                      Training files uploaded to data/raw
                    </Show>
                  </h1>
                  <p class="login-subtitle">
                    <Show
                      when={isTrainingDay()}
                      fallback="Your .jsonl files were saved under data/raw for the session date in the JSONL folder. Source metadata is inside the file content."
                    >
                      Your .db files were saved under data/raw for the session date taken from the filenames and the selected source. Further processing can be run in a later step.
                    </Show>
                  </p>
                </div>
              </div>

              <div class="login-footer">
                <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top: 8px;">
                  <button
                    onClick={() => { resetUpload(); }}
                    class="login-button"
                  >
                    <span class="button-text">Upload More Files</span>
                    <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                      <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                  <button
                    onClick={() => {
                      // Clear dataset selection so user returns to datasets page
                      setSelectedDatasetId(0);
                      setSelectedDate("");
                      navigate('/dashboard');
                    }}
                    class="login-button"
                    style="background:#2563eb"
                  >
                    <span class="button-text">Go to Dashboard</span>
                  </button>
                </div>
              </div>
            </Show>

            <Show when={uploadFailed()}>
              <div class="login-header">
                <div class="logo-section">
                  <div class="logo-icon" style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" />
                      <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2" />
                      <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2" />
                    </svg>
                  </div>
                  <h1 class="login-title">Upload Failed</h1>
                  <p class="login-subtitle">
                    {errorMessage() || 'There was an error uploading your files.'}
                  </p>
                </div>
              </div>

              <div class="login-footer">
                <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top: 8px;">
                  <button
                    onClick={() => { resetUpload(); }}
                    class="login-button"
                  >
                    <span class="button-text">Try Again</span>
                    <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M1 4v6h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                      <path d="M23 20v-6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                      <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                </div>
              </div>
            </Show>
          </div>
        </div>

        <BackButton />
      </div>

      {/* Process Conflict Modal */}
      <Show when={showProcessConflictModal()}>
        <Portal>
          <div
            class="pagesettings-overlay"
            onClick={() => {
              // Don't close on overlay click - user must make a choice
            }}
            style={{
              display: 'flex',
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              'background-color': 'rgba(0, 0, 0, 0.5)',
              'z-index': 10000,
              'align-items': 'center',
              'justify-content': 'center'
            }}
          >
            <div
              class="pagesettings-modal"
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'relative',
                'z-index': 10001,
                'max-width': '600px',
                width: '90%'
              }}
            >
              <div class="flex justify-between items-center p-4 border-b" style="border-color: var(--color-border-primary);">
                <h2 class="text-lg font-semibold" style="color: var(--color-text-primary);">
                  Processes Already Running
                </h2>
                <button
                  onClick={() => {
                    setShowProcessConflictModal(false);
                    setRunningProcessesInfo(null);
                  }}
                  class="text-gray-500 hover:text-gray-700 transition-colors"
                  style="color: var(--color-text-secondary);"
                >
                  <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                  </svg>
                </button>
              </div>

              <div class="p-6">
                <p style="color: var(--color-text-primary); margin-bottom: 1rem;">
                  There {runningProcessesInfo()?.running_count === 1 ? 'is' : 'are'} {runningProcessesInfo()?.running_count || 0} process{runningProcessesInfo()?.running_count !== 1 ? 'es' : ''} already running:
                </p>

                <div style="background-color: var(--color-bg-secondary); padding: 1rem; border-radius: 4px; margin-bottom: 1.5rem; max-height: 200px; overflow-y: auto;">
                  <For each={runningProcessesInfo()?.processes || []}>
                    {(proc: any) => (
                      <div style="margin-bottom: 0.5rem; color: var(--color-text-primary);">
                        <strong>{proc.script_name}</strong> ({proc.class_name})
                        <br />
                        <span style="font-size: 0.875rem; color: var(--color-text-secondary);">
                          Started: {new Date(proc.started_at).toLocaleString() || 'unknown'}
                        </span>
                      </div>
                    )}
                  </For>
                </div>

                <p style="color: var(--color-text-primary); margin-bottom: 1.5rem;">
                  Would you like to:
                </p>
                <ul style="color: var(--color-text-primary); margin-bottom: 1.5rem; padding-left: 1.5rem;">
                  <li>Cancel the running process{runningProcessesInfo()?.running_count !== 1 ? 'es' : ''} and start the upload</li>
                  <li>Add this upload to the queue (wait for processes to complete)</li>
                </ul>

                <div style={{ display: 'flex', 'justify-content': 'flex-end', gap: '0.5rem' }}>
                  <button
                    onClick={() => {
                      setShowProcessConflictModal(false);
                      setRunningProcessesInfo(null);
                    }}
                    class="px-4 py-2 text-sm rounded-md transition-colors"
                    style="background-color: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleUploadWithProcessDecision(false)}
                    class="px-4 py-2 text-sm rounded-md transition-colors font-medium"
                    style="background-color: var(--color-bg-button); color: var(--color-text-inverse);"
                  >
                    Add to Queue
                  </button>
                  <button
                    onClick={() => handleUploadWithProcessDecision(true)}
                    class="px-4 py-2 text-sm rounded-md transition-colors font-medium"
                    style="background-color: #dc2626; color: white;"
                  >
                    Cancel Processes & Upload
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
};
