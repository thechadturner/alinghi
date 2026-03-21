import { createSignal, Show, For, onMount, createEffect, onCleanup } from "solid-js";
import { selectedTime } from "../store/playbackStore";
import { useNavigate, useLocation } from "@solidjs/router";

import BackButton from "../components/buttons/BackButton";
import WaitingModal from "../components/utilities/WaitingModal";
import LoadingOverlay from "../components/utilities/Loading";

import { persistantStore } from "../store/persistantStore";
import { processStore } from "../store/processStore";
import { sseManager } from "../store/sseManager";
import { apiEndpoints } from "@config/env";
import { getCookie, getData } from "../utils/global";
import { authManager } from "../utils/authManager";
import { error as logError, info as logInfo, debug as logDebug, warn as logWarn } from "../utils/console";
const { selectedClassName, selectedProjectId, selectedDatasetId, selectedDate: storeSelectedDate } = persistantStore;

const env = import.meta.env;

/** Extract media source from filename: label after ONBOARD_, first 3 characters (e.g. SGP_AKL_260215_DAY2_ONBOARD_AUS2_LR_data.mp4 → AUS). */
function extractMediaSourceFromFilename(filename: string): string | null {
  const match = filename.match(/ONBOARD_([A-Za-z0-9]{3})/i);
  return match ? match[1].toUpperCase() : null;
}

export default function UploadMediaPage() {
  const location = useLocation();
  const navigate = useNavigate();
  
  const file_type = typeof location.state === "object" && location.state !== null && "file_type" in location.state ? (location.state as { file_type: string }).file_type : undefined;

  const [files, setFiles] = createSignal<File[]>([]);
  const [showWaiting, setShowWaiting] = createSignal(false);
  const [processId, setProcessId] = createSignal('');
  const [uploadSuccess, setUploadSuccess] = createSignal(false);
  const [showModal, setShowModal] = createSignal(false);
  const [readyVideoPath, setReadyVideoPath] = createSignal('');
  const [uploadFailed, setUploadFailed] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal('');
  const [selectedDate, setSelectedDate] = createSignal((() => {
    try {
      // First check selectedDate from persistantStore if valid
      const storeDate = storeSelectedDate?.();
      if (storeDate && typeof storeDate === 'string' && storeDate.trim()) {
        // Handle YYYYMMDD format
        if (/^\d{8}$/.test(storeDate)) {
          return `${storeDate.substring(0,4)}-${storeDate.substring(4,6)}-${storeDate.substring(6,8)}`;
        }
        // Handle YYYY-MM-DD format
        if (/^\d{4}-\d{2}-\d{2}$/.test(storeDate)) {
          return storeDate;
        }
      }
      
      // Prefer selectedTime date if available (skip epoch / unset default 1970-01-01)
      const t = selectedTime?.();
      if (t instanceof Date && !isNaN(t.getTime()) && t.getFullYear() >= 2000) {
        const yyyy = t.getFullYear();
        const mm = String(t.getMonth() + 1).padStart(2, '0');
        const dd = String(t.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
      }
      
      // Fallback to stored lastMediaUploadDate (YYYYMMDD)
      const stored = localStorage.getItem('lastMediaUploadDate');
      if (stored && /^\d{8}$/.test(stored)) {
        return `${stored.substring(0,4)}-${stored.substring(4,6)}-${stored.substring(6,8)}`;
      }
    } catch {}
    return '2026-07-01'; // default when no store/time/localStorage date
  })());
  const [dateError, setDateError] = createSignal('');
  const [mediaSource, setMediaSource] = createSignal('');
  const [autoDetectMediaSource, setAutoDetectMediaSource] = createSignal(true);
  const [uploadProgress, setUploadProgress] = createSignal<number | null>(null);
  /** When multiple media sources are uploaded, we track all process_ids and close modal when all complete. */
  const [batchProcessIds, setBatchProcessIds] = createSignal<string[]>([]);
  const [timezone, setTimezone] = createSignal('Europe/Madrid');
  const [useFileDatetime, setUseFileDatetime] = createSignal(true);
  const [timezones, setTimezones] = createSignal<string[]>([]);

  /** All unique media sources detected from selected files (sorted). */
  const detectedMediaSources = (): string[] => {
    if (!autoDetectMediaSource()) return [];
    const set = new Set<string>();
    files().forEach((file) => {
      const s = extractMediaSourceFromFilename(file.name);
      if (s) set.add(s);
    });
    return Array.from(set).sort();
  };

  /** When auto-detect is on and a single source: that source; else manual mediaSource() for single-request path. Always uppercase. */
  const effectiveMediaSource = (): string => {
    if (!autoDetectMediaSource()) return (mediaSource() ?? '').trim().toUpperCase();
    const sources = detectedMediaSources();
    return sources.length === 1 ? sources[0]! : '';
  };

  /** Group files by detected media source (key '' = no match). Used when auto-detect and multiple sources. */
  const filesByMediaSource = (): Map<string, File[]> => {
    const map = new Map<string, File[]>();
    files().forEach((file) => {
      const key = extractMediaSourceFromFilename(file.name) ?? '';
      const list = map.get(key) ?? [];
      list.push(file);
      map.set(key, list);
    });
    return map;
  };

  // When multiple video batches are in progress, close modal and show success only when all complete
  createEffect(() => {
    const pids = batchProcessIds();
    if (pids.length === 0 || !showModal()) return;
    const unsubs: (() => void)[] = [];
    const checkAllComplete = () => {
      const allDone = pids.every((pid) => {
        const state = processStore.getProcess(pid);
        return state && (state.status === 'complete' || state.status === 'timeout' || state.status === 'error');
      });
      if (allDone) {
        setShowModal(false);
        setUploadSuccess(true);
        setFiles([]);
        setBatchProcessIds([]);
      }
    };
    pids.forEach((pid) => {
      unsubs.push(processStore.subscribe(pid, checkAllComplete));
    });
    checkAllComplete(); // in case already all done (e.g. skip-ffmpeg completions arrived before we subscribed)
    // Poll fallback: completions may be processed before we subscribed (SSE/poll timing)
    const interval = setInterval(checkAllComplete, 1000);
    onCleanup(() => {
      unsubs.forEach((u) => u());
      clearInterval(interval);
    });
  });

  const supportsUpload = () => ['target','polar','video'].includes(file_type || '');

  const acceptAttr = () => {
    if (file_type === 'video') return 'video/mp4';
    if (file_type === 'target' || file_type === 'polar') return '.csv';
    if (file_type === 'image') return 'image/*';
    return '';
  };

  const handleFileChange = (event: Event) => {
    const selectedFiles = Array.from((event.target as HTMLInputElement).files || []);
    setFiles([...files(), ...selectedFiles]);
  };

  const removeFile = (index: number) => {
    setFiles(files().filter((_, i) => i !== index));
  };

  const resetUpload = () => {
    setUploadSuccess(false);
    setUploadFailed(false);
    setErrorMessage('');
    setFiles([]);
  };

  const handleUpload = async () => {
    setShowWaiting(true);
    setUploadProgress(null);

    // Ensure class name matches server validation regex: /^[a-zA-Z_][a-zA-Z0-9_]*$/
    const className = selectedClassName().toLowerCase().replace(/[^a-zA-Z0-9_]/g, '_');
    const projectId = selectedProjectId().toString();

    const applyError = (status: number, statusText: string, errorText: string) => {
      logError('Failed to upload files:', status, statusText);
      logError('Error details:', errorText);
      setUploadFailed(true);
      setShowWaiting(false);
      setUploadProgress(null);
      try {
        const errorJson = JSON.parse(errorText);
        setErrorMessage(errorJson.message ? `Upload failed: ${errorJson.message}` : `Upload failed: ${status} ${statusText}`);
      } catch {
        setErrorMessage(`Upload failed: ${status} ${statusText}`);
      }
      setTimeout(() => resetUpload(), 5000);
    };

    // Video: validate date once
    let yyyymmdd = '';
    if (file_type === 'video') {
      try {
        const raw = (selectedDate() || '').trim();
        const dash = /^\d{4}-\d{2}-\d{2}$/;
        const compact = /^\d{8}$/;
        if (dash.test(raw)) {
          yyyymmdd = raw.replaceAll('-', '');
        } else if (compact.test(raw)) {
          yyyymmdd = raw;
        } else {
          setShowWaiting(false);
          setDateError('Enter date as YYYY-MM-DD or YYYYMMDD');
          return;
        }
        setDateError('');
        try { localStorage.setItem('lastMediaUploadDate', yyyymmdd); } catch {}
      } catch {
        setShowWaiting(false);
        return;
      }
    }

    const accessToken = authManager.getAccessToken();
    const csrfToken = getCookie('csrf_token') || '';
    const url = `${apiEndpoints.admin.upload}/${file_type}`;

    const applySuccess = (response_json: { process_id?: string; data?: { process_id?: string; encoding_skipped?: boolean }; encoding_skipped?: boolean }) => {
      logInfo('Upload successful', response_json);
      if (file_type === 'video') {
        const encodingSkipped = response_json.encoding_skipped === true || response_json?.data?.encoding_skipped === true;
        if (encodingSkipped) {
          setUploadSuccess(true);
          setFiles([]);
          setShowWaiting(false);
          setUploadProgress(null);
          return;
        }
        let pid = response_json.process_id || response_json?.data?.process_id;
        if (!pid) {
          logWarn('No process_id in response, using fallback');
          pid = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }
        setProcessId(pid);
        logInfo('Video upload started with process_id:', pid);
        processStore.startProcess(pid, 'video_upload');
        setShowModal(true);
        setFiles([]);
      } else {
        setUploadSuccess(true);
        setTimeout(() => navigate(`/dashboard`, { replace: true }), 3000);
        setFiles([]);
      }
      setShowWaiting(false);
      setUploadProgress(null);
    };

    try {
      if (file_type === 'video') {
        await sseManager.connectToServer(8059);
        const useMultiBatch = autoDetectMediaSource() && detectedMediaSources().length > 1;
        if (useMultiBatch) {
          const groups = filesByMediaSource();
          const entries = Array.from(groups.entries()).filter(([, list]) => list.length > 0);
          const totalBatches = entries.length;
          const collectedPids: string[] = [];
          const collectedEncodingSkipped: boolean[] = [];
          let completed = 0;
          let hadError = false;
          // Per-batch progress so cumulative stays smooth when multiple XHRs run in parallel
          const batchProgress: { loaded: number; total: number }[] = Array.from(
            { length: totalBatches },
            () => ({ loaded: 0, total: 1 })
          );
          let maxProgress = 0;
          const updateCumulativeProgress = (batchIndex: number, loaded: number, total: number) => {
            batchProgress[batchIndex] = { loaded, total: total > 0 ? total : 1 };
            const cumulative =
              (batchProgress.reduce(
                (sum, p) => sum + (p.total > 0 ? p.loaded / p.total : 0),
                0
              ) /
                totalBatches) *
              100;
            const rounded = Math.round(cumulative);
            const next = Math.min(100, Math.max(maxProgress, rounded));
            if (next > maxProgress) maxProgress = next;
            setUploadProgress(next);
          };
          for (let batchIndex = 0; batchIndex < entries.length; batchIndex++) {
            const [mediaSourceKey, groupFiles] = entries[batchIndex]!;
            const fd = new FormData();
            fd.append('class_name', className);
            fd.append('project_id', projectId);
            fd.append('date', yyyymmdd);
            if (mediaSourceKey) fd.append('media_source', mediaSourceKey.toUpperCase());
            const tz = timezone()?.trim();
            if (tz) fd.append('timezone', tz);
            fd.append('use_file_datetime', useFileDatetime() ? 'true' : 'false');
            groupFiles.forEach((f) => fd.append('files', f));
            logInfo('Uploading video batch', { mediaSource: mediaSourceKey || '(default)', count: groupFiles.length });
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            xhr.withCredentials = true;
            xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
            if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
            xhr.upload.addEventListener('progress', (e) => {
              if (e.lengthComputable) {
                updateCumulativeProgress(batchIndex, e.loaded, e.total > 0 ? e.total : 1);
              }
            });
            xhr.addEventListener('load', () => {
              if (hadError) return;
              if (xhr.status >= 200 && xhr.status < 300) {
                try {
                  const res = JSON.parse(xhr.responseText || '{}');
                  const encodingSkipped = res.encoding_skipped === true || res?.data?.encoding_skipped === true;
                  collectedEncodingSkipped.push(encodingSkipped);
                  const pid = res.process_id || res?.data?.process_id;
                  if (pid && !encodingSkipped) {
                    collectedPids.push(pid);
                    processStore.startProcess(pid, 'video_upload', false);
                  }
                } catch {}
              } else {
                applyError(xhr.status, xhr.statusText, xhr.responseText || '');
                hadError = true;
              }
              completed += 1;
              if (completed >= totalBatches && !hadError) {
                const allEncodingSkipped = collectedEncodingSkipped.length === totalBatches && collectedEncodingSkipped.every(Boolean);
                if (allEncodingSkipped) {
                  setUploadSuccess(true);
                  setFiles([]);
                  setShowWaiting(false);
                  setUploadProgress(null);
                } else if (collectedPids.length > 0) {
                  setProcessId(collectedPids[0]!);
                  setBatchProcessIds(collectedPids);
                  setShowModal(true);
                  setFiles([]);
                  setShowWaiting(false);
                  setUploadProgress(null);
                }
              }
            });
            xhr.addEventListener('error', () => {
              if (!hadError) {
                applyError(0, 'Network error', xhr.responseText || 'Network error');
                hadError = true;
              }
            });
            xhr.send(fd);
          }
          return;
        }

        // Single video batch
        const formData = new FormData();
        files().forEach((file) => formData.append('files', file));
        formData.append('class_name', className);
        formData.append('project_id', projectId);
        formData.append('date', yyyymmdd);
        const source = effectiveMediaSource();
        if (source) formData.append('media_source', source);
        const tz = timezone()?.trim();
        if (tz) formData.append('timezone', tz);
        formData.append('use_file_datetime', useFileDatetime() ? 'true' : 'false');
        logInfo('Uploading files', { files: files().map((f) => f.name) });
        logDebug('Upload metadata', { originalClassName: selectedClassName(), className, projectId, file_type });
        let singleBatchMaxProgress = 0;
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
        if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable && e.total > 0) {
            const pct = Math.round((e.loaded / e.total) * 100);
            const next = Math.min(100, Math.max(singleBatchMaxProgress, pct));
            if (next > singleBatchMaxProgress) singleBatchMaxProgress = next;
            setUploadProgress(next);
          }
        });
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const response_json = JSON.parse(xhr.responseText || '{}');
              applySuccess(response_json);
            } catch {
              applyError(xhr.status, xhr.statusText, xhr.responseText || '');
            }
          } else {
            applyError(xhr.status, xhr.statusText, xhr.responseText || '');
          }
        });
        xhr.addEventListener('error', () => {
          applyError(0, 'Network error', xhr.responseText || 'Network error');
        });
        xhr.addEventListener('abort', () => {
          setShowWaiting(false);
          setUploadProgress(null);
        });
        xhr.send(formData);
        return;
      }

      // Non-video: single FormData with all files
      const formData = new FormData();
      files().forEach((file) => formData.append('files', file));
      formData.append('class_name', className);
      formData.append('project_id', projectId);
      logInfo('Uploading files', { files: files().map((f) => f.name) });
      logDebug('Upload metadata', { originalClassName: selectedClassName(), className, projectId, file_type });

      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'X-CSRF-Token': csrfToken
        },
        body: formData
      });

      if (response.ok) {
        const response_json = await response.json();
        applySuccess(response_json);
      } else {
        const errorText = await response.text();
        applyError(response.status, response.statusText, errorText);
      }
      if (file_type !== 'video') {
        setShowWaiting(false);
        setUploadProgress(null);
      }
    } catch (error) {
      logError('Error uploading files:', error);
      setUploadFailed(true);
      setErrorMessage(`Upload error: ${(error as Error).message}`);
      setTimeout(() => resetUpload(), 5000);
      setShowWaiting(false);
      setUploadProgress(null);
    }
  };

  const handleBatchComplete = (data) => {
    try {
      const first = (data?.outputs || [])[0];
      const med = first?.renditions?.find(r => r.name === 'med_res') || first?.renditions?.[0];
      if (med?.file) {
        setReadyVideoPath(med.file);
        try { sessionStorage.setItem('video_review_path', med.file); } catch {}
      }
    } catch {}
    setShowWaiting(false);
    setUploadSuccess(true);
  };

  const fetchTimezones = async () => {
    const projectId = selectedProjectId?.();
    if (projectId == null || file_type !== 'video') return;
    const controller = new AbortController();
    try {
      const response = await getData(`${apiEndpoints.app.admin.timezones}?project_id=${encodeURIComponent(projectId)}`, controller.signal);
      if (response.success && response.data) {
        const tzNames = (response.data as Array<{ name?: string } | string>)
          .map((tz) => (typeof tz === 'object' && tz?.name ? tz.name : String(tz)))
          .filter(Boolean)
          .sort();
        setTimezones(tzNames);
        logDebug('UploadMedia: Loaded timezones', tzNames.length);
        const defaultTz = tzNames.find((tz) => tz.toLowerCase() === 'europe/madrid');
        if (defaultTz) setTimezone(defaultTz);
      } else {
        setTimezones([]);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') logError('UploadMedia: Error fetching timezones', err);
      setTimezones([]);
    }
  };

  // Fetch dataset date on mount if selectedDatasetId > 0; fetch timezones for video
  onMount(async () => {
    if (file_type === 'video' && selectedProjectId?.()) await fetchTimezones();
    const datasetId = selectedDatasetId?.();
    if (datasetId && datasetId > 0) {
      try {
        logDebug('UploadMedia: Fetching dataset date for datasetId:', datasetId);
        const response = await getData(
          `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}`
        );
        
        if (response.success && response.data?.date) {
          let dateStr = response.data.date;
          // If date is in YYYYMMDD format, convert to YYYY-MM-DD
          if (dateStr.length === 8 && !dateStr.includes('-')) {
            dateStr = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
          }
          logDebug('UploadMedia: Setting date from dataset:', dateStr);
          setSelectedDate(dateStr);
          // Also persist to localStorage
          try {
            const yyyymmdd = dateStr.replaceAll('-', '');
            localStorage.setItem('lastMediaUploadDate', yyyymmdd);
          } catch {}
        }
      } catch (err) {
        logError('UploadMedia: Error fetching dataset date:', err);
      }
    } else {
      // If no datasetId, check if storeSelectedDate is valid and use it
      const storeDate = storeSelectedDate?.();
      if (storeDate && typeof storeDate === 'string' && storeDate.trim()) {
        let formattedDate = storeDate;
        // Handle YYYYMMDD format
        if (/^\d{8}$/.test(storeDate)) {
          formattedDate = `${storeDate.substring(0,4)}-${storeDate.substring(4,6)}-${storeDate.substring(6,8)}`;
        }
        // Only update if it's a valid date format
        if (/^\d{4}-\d{2}-\d{2}$/.test(formattedDate)) {
          logDebug('UploadMedia: Setting date from storeSelectedDate:', formattedDate);
          setSelectedDate(formattedDate);
        }
      }
    }
  });

  return (
    <>
      <Show when={showWaiting()}>
        <LoadingOverlay
          fullScreen
          message={file_type === 'video' ? 'Uploading video... This may take several minutes for large files.' : 'Uploading files...'}
          progress={uploadProgress()}
          showProgress={file_type === 'video' && uploadProgress() !== null}
          progressMessage={uploadProgress() !== null ? 'Sending file to server...' : 'Preparing...'}
        />
      </Show>
      <WaitingModal 
        visible={showModal()}
        process_id={processId()}
        acceptProcessIds={batchProcessIds().length > 1 ? batchProcessIds() : undefined}
        customStatus={batchProcessIds().length > 1 ? `Waiting for ${batchProcessIds().length} uploads to complete...` : undefined}
        title="Uploading Videos..."
        subtitle={batchProcessIds().length > 1
          ? `Uploading ${batchProcessIds().length} media sources. This may take a few minutes; the window will close when all are complete.`
          : 'This may take a few minutes so feel free to close this window and move onto other tasks while you wait. A notification will be sent when the process is completed!'}
        disableAutoNavigation={batchProcessIds().length > 1}
        onClose={() => { setShowModal(false); setBatchProcessIds([]); }}
      />
      
      <Show when={!showWaiting()}>
      <div class="login-page" style="max-height:calc(100vh - 60px); overflow:auto;">
      <div class="login-container" style="max-width: 800px;">
        <Show when={!uploadSuccess() && !uploadFailed()}>
          <div class="login-header">
            <div class="logo-section">
              <div class="logo-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <polyline points="10,9 9,9 8,9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <h1 class="login-title">
                <Show when={file_type == 'target'}>Upload Targets</Show>
                <Show when={file_type == 'polar'}>Upload Polars</Show>
                <Show when={file_type == 'video'}>Upload Videos</Show>
                <Show when={file_type == 'image'}>Upload Images</Show>
              </h1>
              <p class="login-subtitle">
                <Show when={file_type == 'target'}>Upload or replace target files for your project</Show>
                <Show when={file_type == 'polar'}>Upload or replace polar files for your project</Show>
                <Show when={file_type == 'video'}>Upload or replace MP4 videos for your project</Show>
                <Show when={file_type == 'image'}>Select images to upload (not yet supported by server)</Show>
              </p>
            </div>
          </div>
          
          <form class="login-form" onSubmit={(e) => { e.preventDefault(); handleUpload(); }}>
            <div class="form-group" style="margin-bottom:12px;">
              <label for="dateInput" class="form-label" style="display:block;margin-bottom:6px;">File Date</label>
              <input
                id="dateInput"
                type="date"
                class="upload-media-date-input"
                value={selectedDate()}
                onInput={(e) => { 
                  setSelectedDate(e.currentTarget.value); 
                  setDateError(''); 
                  try {
                    const v = (e.currentTarget.value || '').trim();
                    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
                      localStorage.setItem('lastMediaUploadDate', v.replaceAll('-', ''));
                    }
                  } catch {}
                }}
              />
              <Show when={dateError()}>
                <div class="upload-media-date-error">{dateError()}</div>
              </Show>
            </div>
            <Show when={file_type === 'video'}>
              <div class="form-group">
                <label for="timezoneSelect" class="form-label">Timezone</label>
                <div class="input-container">
                  <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                    <polyline points="12,6 12,12 16,14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  <select
                    id="timezoneSelect"
                    class="form-input"
                    value={timezone()}
                    onInput={(e) => setTimezone((e.target as HTMLSelectElement).value)}
                  >
                    <Show
                      when={timezones().length > 0}
                      fallback={<option value={timezone()}>{timezone()}</option>}
                    >
                      <option value="">-- Select Timezone --</option>
                      <For each={timezones()}>
                        {(tz) => <option value={tz}>{tz}</option>}
                      </For>
                    </Show>
                  </select>
                </div>
              </div>
              <div class="form-group upload-media-autodetect-row">
                <label class="upload-media-checkbox-label">
                  <input
                    type="checkbox"
                    checked={useFileDatetime()}
                    onChange={(e) => setUseFileDatetime(e.currentTarget.checked)}
                  />
                  <span>Use datetime from video files</span>
                </label>
              </div>
              <div class="form-group upload-media-autodetect-row">
                <label class="upload-media-checkbox-label">
                  <input
                    type="checkbox"
                    checked={autoDetectMediaSource()}
                    onChange={(e) => setAutoDetectMediaSource(e.currentTarget.checked)}
                  />
                  <span>Automatically detect media source from file names</span>
                </label>
                <Show when={autoDetectMediaSource() && files().length > 0 && detectedMediaSources().length > 0}>
                  <div class="upload-media-detected-source">Detected: <strong>{detectedMediaSources().join(', ')}</strong></div>
                </Show>
              </div>
              <Show when={!autoDetectMediaSource()}>
                <div class="form-group" style="margin-bottom:12px;">
                  <label for="mediaSource" class="form-label" style="display:block;margin-bottom:6px;">Media Source</label>
                  <input
                    id="mediaSource"
                    type="text"
                    class="upload-media-source-input"
                    placeholder="e.g., GoPro_DeckCam or AUS"
                    value={mediaSource()}
                    onInput={(e) => setMediaSource(e.currentTarget.value)}
                  />
                </div>
              </Show>
            </Show>
            <div class="form-group">
              <label for="fileInput" class="form-label">Select Files</label>
              <div class="file-upload-container">
                <input
                  id="fileInput"
                  type="file"
                  multiple
                  onChange={handleFileChange}
                  class="file-input"
                  accept={acceptAttr()}
                />
                <label for="fileInput" class="file-upload-label">
                  <svg class="file-upload-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <polyline points="7,10 12,15 17,10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  <span class="file-upload-text">Choose files or drag and drop</span>
                  <span class="file-upload-subtext">
                    <Show when={file_type == 'video'}>Supported: MP4</Show>
                    <Show when={file_type == 'target' || file_type == 'polar'}>Supported: CSV</Show>
                    <Show when={file_type == 'image'}>Supported: Images (UI only; backend pending)</Show>
                  </span>
                </label>
              </div>
            </div>
            <Show when={!supportsUpload()}>
              <div class="files-list-title" style="color:#dc2626;margin-bottom:8px;">This upload type is not supported yet.</div>
            </Show>
            
            {files().length > 0 && (
              <div class="files-list">
                <h3 class="files-list-title">Selected Files ({files().length})</h3>
                <div class="files-table">
                  {files().map((file, index) => (
                    <div class="file-item" data-key={index}>
                      <div class="file-info">
                        <svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                          <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        <span class="file-name">{file.name}</span>
                        <span class="file-size">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                      </div>
                      <button 
                        type="button"
                        onClick={() => removeFile(index)} 
                        class="remove-file-btn"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                          <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            <Show when={uploadFailed()}>
              <div style="color:#dc2626;margin-bottom:8px;">{errorMessage() || 'Upload failed...'}</div>
            </Show>
            <button type="submit" class="login-button" disabled={files().length === 0 || !supportsUpload()}>
              <span class="button-text">Upload Files</span>
              <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <polyline points="7,10 12,15 17,10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </form>
        </Show>

        <Show when={uploadSuccess()}>
          <div class="login-header">
            <div class="logo-section">
              <div class="logo-icon" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 12L11 14L15 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <h1 class="login-title">Video Uploaded!</h1>
              <p class="login-subtitle">
                Your video is ready.
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
                  <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <button 
                onClick={() => {
                  const fromForm = selectedDate()?.replace(/-/g, '').trim().slice(0, 8);
                  const yyyymmdd = (fromForm && fromForm.length === 8) ? fromForm : (() => {
                    const stored = localStorage.getItem('lastMediaUploadDate');
                    return (stored && /^\d{8}$/.test(stored)) ? stored : '';
                  })();
                  navigate(yyyymmdd ? `/video-sync?date=${yyyymmdd}` : '/video-sync');
                }}
                class="login-button"
                style="background:#2563eb"
              >
                <span class="button-text">Review Video</span>
              </button>
            </div>
          </div>
        </Show>
        
        {/* Small inline failure message handled above button now; hiding large failure block */}
      </div>
      
      <BackButton />
    </div>
    </Show>
    </>
  );
};
